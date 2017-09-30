const { EventEmitter } = require('events')
const typeforce = require('typeforce')
const inherits = require('inherits')
const validateResource = require('@tradle/validate-resource')
const { omitVirtual } = validateResource.utils
const buildResource = require('@tradle/build-resource')
const mergeModels = require('@tradle/merge-models')
const { TYPE, SIG, PREVLINK, PERMALINK } = require('@tradle/constants')
const Gen = require('./gen')
const baseModels = require('./base-models')
const createPrivateModels = require('./private-models')
const {
  co,
  bindAll,
  format,
  uniq,
  omit,
  shallowClone,
  clone,
  deepEqual,
  debug,
  parseId,
  series,
  hashObject,
  modelsToArray,
  createSimpleMessage
} = require('./utils')

const createStateMutater = require('./state')
const createPlugins = require('./plugins')
const createDefaultPlugins = require('./default-plugins')
const STRINGS = require('./strings')
const createDefiner = require('./definer')
const triggerBeforeAfter = require('./trigger-before-after')
const DENIAL = 'tradle.ApplicationDenial'
const types = {
  request: typeforce.compile({
    user: typeforce.Object,
    application: typeforce.maybe(typeforce.Object),
    // inbound object
    object: typeforce.maybe(typeforce.Object),
    // inbound message
    message: typeforce.maybe(typeforce.Object)
  })
}

exports = module.exports = opts => new Strategy(opts)

function Strategy (opts) {
  EventEmitter.call(this)
  bindAll(this)

  const { namespace, models, products } = opts
  this.namespace = namespace
  const privateModels = createPrivateModels(namespace)
  this.models = {
    private: privateModels,
    all: mergeModels()
      .add(baseModels)
      .add(privateModels.all)
      .get()
  }

  this._stateProps = Object.keys(privateModels.customer.properties)
  this.plugins = createPlugins()
  this.plugins.setContext(this)
  this._define = createDefiner()
  // be lazy
  this._define('_modelsArray', () => modelsToArray(this.models.all))
  this._define('_latestModelsHash', () => hashObject(this._modelsArray))
  Object.defineProperty(this, 'products', {
    get() {
      const { biz } = this.models
      return biz ? biz.products : []
    }
  })

  if (products) {
    this.addProducts({ models, products })
  }

  triggerBeforeAfter(this, [
    'send',
    'sign',
    'seal',
    'save',
    'verify',
    'approveApplication',
    'denyApplication'
  ])

  // ;['send', 'rawSend', 'sign'].forEach(method => {
  //   this[method] = (...args) => this._exec(method, ...args)
  //   this._hooks.hook('_' + method, this['_' + method])
  // })
}

inherits(Strategy, EventEmitter)
const proto = Strategy.prototype

proto.install = function (bot) {
  this.bot = bot
  this.uninstall = bot.onmessage(this._onmessage)
  this.emit('bot', bot)
  return this
}

proto.addProducts = function addProducts ({ models, products }) {
  this.models.biz = Gen.applicationModels({
    models: shallowClone(this.models.all, models ? models.all : {}),
    products: uniq(products.concat(this.products)),
    namespace: this.namespace
  })

  if (models) {
    ;['private', 'biz'].forEach(subset => {
      if (!models[subset] || !models[subset].all) return

      if (!this.models[subset]) {
        this.models[subset] = {}
      }

      const all = shallowClone(
        this.models[subset].all,
        models[subset].all
      )

      this.models[subset] = shallowClone(this.models[subset], models[subset])
      this.models[subset].all = all
    })
  }

  this.models.all = mergeModels()
    .add(baseModels)
    .add(this.models.private.all)
    .add(this.models.biz.all)
    .get()

  this.state = createStateMutater({ models: this.models })
  this.removeDefaultHandlers()
  this._defaultPlugins = createDefaultPlugins(this)
  this.plugins.use(this._defaultPlugins)

  // don't use delete, need to trigger set() to clear the cached value
  this._modelsArray = undefined
  this._latestModelsHash = undefined

  return this
}

proto._exec = function _exec (method, ...args) {
  const opts = normalizeExecArgs(...arguments)
  return Promise.resolve(this.plugins.exec(opts))
}

proto._execBubble = function _execBubble (method, ...args) {
  const opts = normalizeExecArgs(...arguments)
  opts.allowExit = true
  opts.returnResult = true
  return Promise.resolve(this.plugins.exec(opts))
}

proto._onmessage = co(function* (data) {
  const req = this.state.newRequestState(data)
  const { user, message, type } = data
  const { state, models } = this
  if (!user.identity) {
    try {
      const identity = yield this.bot.addressBook.byPermalink(user.id)
      state.setIdentity({ user, identity })
    } catch (err) {
      debug(`don't have user's identity!`)
    }
  }

  if (!req.object && req.payload) {
    req.object = req.payload
  }

  req.models = models
  if (message.context) {
    req.context = message.context
  }

  // make a defensive copy
  const userId = data.user.id
  try {
    yield this._processIncoming(req)
  } catch (err) {
    debug(`failed to process incoming message from ${userId}`, err)
    throw err
  } finally {
    const sendQueue = req.sendQueue.slice()
    const n = sendQueue.length
    if (n) {
      debug(`processing ${n} items in send queue to ${userId}`)
      yield series(sendQueue, opts => this.rawSend(opts))
    }
  }

  const shouldSeal = yield this._exec({
    method: 'shouldSealReceived',
    args: [req],
    returnResult: true,
    allowExit: true
  })

  if (shouldSeal) {
    yield this.seal(req)
  }
})

proto._processIncoming = co(function* (req) {
  const { state, models } = this
  const { user, type } = req
  const model = models.all[type]
  // init is non-destructive
  state.init(user)
  state.deduceCurrentApplication(req)

  let applicationPreviousVersion
  let { application } = req
  if (application) {
    // lookup current application state
    req.application = yield this.getApplicationByStub(application);
    ({ application } = req)
    applicationPreviousVersion = clone(application)
  }

  let keepGoing = yield this._execBubble('onmessage', req)
  if (keepGoing === false) {
    debug('early exit after "onmessage"')
    return
  }

  keepGoing = yield this._execBubble(`onmessage:${type}`, req)
  if (keepGoing === false) {
    debug(`early exit after "onmessage:${type}"`)
    return
  }

  if (model.subClassOf) {
    keepGoing = yield this._execBubble(`onmessage:${model.subClassOf}`, req)
    if (keepGoing === false) {
      debug(`early exit after "onmessage:${model.subClassOf}"`)
      return
    }
  }

  ({ application } = req)
  if (!application || deepEqual(application, applicationPreviousVersion)) {
    return
  }

  if (applicationPreviousVersion) {
    application = yield this.saveNewVersionOfApplication({ user, application })
  } else {
    yield this.saveApplication({ user, application })
  }
})

/**
 * update PERMALINK, PREVLINK on application, save new application version
 */
proto.saveNewVersionOfApplication = function ({ user, application }) {
  return this.createNewVersionOfApplication(application)
    .then(application => this.saveApplication({ user, application }))
}

proto.createNewVersionOfApplication = function (application) {
  application = toNewVersion(application)
  this.state.updateApplication({
    application,
    properties: { dateModified: Date.now() }
  })

  return this.bot.sign(application)
}

proto.getApplicationByStub = function ({ id, statePermalink }) {
  if (statePermalink) {
    return this.getApplication(statePermalink)
  } else {
    return this.getApplication(parseId(id).permalink)
  }
}

proto.getApplication = function (permalink) {
  return this.bot.db.latest({
    [TYPE]: this.models.private.application.id,
    _permalink: permalink
  })
}

proto.removeDefaultHandler = function (method) {
  if (this._defaultPlugins) {
    const handlers = this._defaultPlugins[method]
    this.plugins.unregister(method, handlers)
    return handlers
  }
}

proto.removeDefaultHandlers = function () {
  if (this._defaultPlugins) {
    return this.plugins.remove(this._defaultPlugins)
  }
}

proto.rawSend = function ({ req, to, object, other={} }) {
  debug(`sending ${object[TYPE]} to ${to}`)
  this.bot.presignEmbeddedMediaLinks(object)
  return this.bot.send({ to, object, other })
}

proto.seal = function seal (opts) {
  const { link, object } = opts
  return this.bot.seal({ link })
}

proto.send = co(function* ({ req, application, to, object, other={} }) {
  typeforce(types.request, req)

  if (to.id) to = to.id

  if (!application) {
    application = req.application
  }

  if (typeof object !== 'object') {
    throw new Error('expected object')
  }

  if (!object[SIG]) {
    object = yield this.sign(object)
  }

  if (application) {
    other.context = this.state.getApplicationContext(application)
  }

  debug(`queueing send to ${to}`)
  const opts = { req, to, object, other }
  if (req.message) {
    req.sendQueue.push(opts)
  } else {
    yield this.rawSend(opts)
  }

  return object
})

proto.sign = co(function* (object) {
  if (typeof object === 'string') {
    object = createSimpleMessage(object)
  }

  const signed = yield this.bot.sign(object)
  const link = buildResource.link(signed)
  buildResource.setVirtual(signed, {
    _link: link,
    _permalink: signed[PERMALINK] || link
  })

  return signed
})

// proxy to facilitate plugin attachment
proto.saveApplication = function ({ user, application }) {
  this.state.updateApplicationStub({ user, application })
  return this.bot.save(application)
}

proto.save = function (signedObject) {
  return this.bot.save(signedObject)
}

proto.signAndSave = co(function* (object) {
  const signed = yield this.sign(object)
  yield this.save(signed)
  return signed
})

proto.continueApplication = co(function* (req) {
  const { application } = req
  if (!application) return

  const requested = yield this.requestNextRequiredItem(req)
  if (!requested) {
    yield this._exec('onFormsCollected', req)
  }
})

proto.forgetUser = function ({ user }) {
  this._stateProps.forEach(prop => {
    if (prop !== 'identity') {
      delete user[prop]
    }
  })

  this.state.init(user)
}

proto.verify = co(function* ({ req, object, verification={} }) {
  const { user } = req
  if (!object) object = req.object

  const { bot, state } = this
  if (typeof user === 'string') {
    user = yield bot.users.get(user)
  }

  const unsigned = state.createVerification({ req, object, verification })
  verification = yield this.send({ req, object: unsigned })
  state.addVerification({ user, object, verification })
  return verification
})

proto.denyApplication = co(function* ({ req, user, application }) {
  if (!user) user = req.user
  if (!application) application = req.application

  const denial = buildResource({
    models: this.models.all,
    model: DENIAL,
  })
  .set({
    // warning: this will link to previous version
    application,
    message: STRINGS.APPLICATION_DENIED
  })
  .toJSON()

  this.state.setApplicationStatus({ application, status: 'denied' })
  this.state.moveToDenied({ user, application })
  return this.send({ req, to: user, object: denial })
})

proto.approveApplication = co(function* ({ req, user, application }) {
  if (!user) user = req.user
  if (!application) application = req.application

  const unsigned = this.state.createCertificate({ application })
  const certificate = yield this.send({ req, to: user, object: unsigned })
  this.state.addCertificate({ user, application, certificate })
  return certificate
})

// proto.revokeCertificate = co(function* ({ user, application, certificate }) {
//   if (!application) {
//     application = user.applicationsApproved.find(app => {
//       return app.certificate._link === certificate._link
//     })
//   }

//   this.state.revokeCertificate({ user, application })
//   return this.send(user, application.certificate)
// })

// promisified because it might be overridden by an async function
proto.getNextRequiredItem = co(function* (req) {
  const { application } = req
  const { models, state } = this
  const productModel = models.all[application.requestFor]
  const required = yield this._exec({
    method: 'getRequiredForms',
    args: [{ req, productModel }],
    returnResult: true
  })

  return required.find(form => {
    return !state.getFormsByType(application.forms, form).length
  })
})

proto.requestNextRequiredItem = co(function* (req) {
  const next = yield this.getNextRequiredItem(req)
  if (!next) return false

  yield this.requestItem({ req, item: next })
  return true
})

// promisified because it might be overridden by an async function
proto.requestItem = co(function* ({ req, item }) {
  const { user, application } = req
  const product = application.requestFor
  const context = parseId(application.request.id).permalink
  debug(`requesting ${item} from user ${user.id} for product ${product}`)
  const reqItem = yield this.createItemRequest({ req, product, item })
  yield this.send({ req, object: reqItem, other: { context } })
  return true
})

// promisified because it might be overridden by an async function
proto.createItemRequest = co(function* ({ req, product, item }) {
  const { user, application } = req
  const itemRequest = {
    [TYPE]: 'tradle.FormRequest',
    form: item
  }

  if (!product && application) {
    product = application.requestFor
  }

  if (product) itemRequest.requestFor = product

  yield this._exec('willRequestForm', {
    req,
    application,
    form: item,
    formRequest: itemRequest,
    user,
    // compat with tradle/tim-bank
    state: user
  })

  return itemRequest
})

proto.sendProductList = co(function* (req) {
  const item = this.models.biz.productRequest.id
  const productChooser = yield this.createItemRequest({ req, item })
  return this.send({ req, object: productChooser })
})

proto.requestEdit = co(function* ({ req, object, details }) {
  const { user } = req
  if (!object) object = req.object

  const { message, errors=[] } = details
  if (!message && errors.length) {
    message = errors[0].error
  }

  debug(`requesting edit for form ${object[TYPE]}`)
  yield this.send({
    req,
    object: {
      _t: 'tradle.FormError',
      prefill: omit(object, '_s'),
      message,
      errors
    }
  })
})

function toNewVersion (object) {
  const newVersion = clone(object)
  delete newVersion[SIG]
  newVersion[PREVLINK] = buildResource.link(object)
  newVersion[PERMALINK] = buildResource.permalink(object)
  return omitVirtual(newVersion, ['_link'])
}

function normalizeExecArgs (method, ...args) {
  return typeof method === 'object'
    ? method
    : { method, args }
}
