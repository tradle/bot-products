const { EventEmitter } = require('events')
const inherits = require('inherits')
const validateResource = require('@tradle/validate-resource')
const validateModels = require('@tradle/validate-model')
const { omitVirtual } = validateResource.utils
const buildResource = require('@tradle/build-resource')
const mergeModels = require('@tradle/merge-models')
const { TYPE, SIG, PREVLINK, PERMALINK } = require('@tradle/constants')
const createLocker = require('promise-locker')
const Gen = require('./gen')
const baseModels = require('./base-models')
const createPrivateModels = require('./private-models')
const {
  co,
  isPromise,
  bindAll,
  format,
  uniq,
  omit,
  pick,
  shallowClone,
  shallowExtend,
  clone,
  deepEqual,
  debug,
  parseId,
  series,
  hashObject,
  modelsToArray,
  createSimpleMessage,
  getValues
} = require('./utils')

const createStateMutater = require('./state')
const createPlugins = require('./plugins')
const createDefaultPlugins = require('./default-plugins')
const STRINGS = require('./strings')
const createDefiner = require('./definer')
const triggerBeforeAfter = require('./trigger-before-after')

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
  this.lock = createLocker()
  this._requestStates = {}
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
    'send', 'sign', 'save'
  ])

  // ;['send', 'rawSend', 'sign'].forEach(method => {
  //   this[method] = (...args) => this._exec(method, ...args)
  //   this._hooks.hook('_' + method, this['_' + method])
  // })
}

inherits(Strategy, EventEmitter)
const proto = Strategy.prototype

proto.getCurrentRequest = function (user) {
  return this._requestStates[user.id || user]
}

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
  if (typeof method === 'object') {
    return Promise.resolve(this.plugins.exec(...arguments))
  }

  return Promise.resolve(this.plugins.exec({ method, args }))
}

proto._setRequest = function (data) {
  const { user } = data
  this._requestStates[user.id] = newRequestState(data)
}

proto._deleteCurrentRequest = function ({ user }) {
  delete this._requestStates[user.id]
}

proto._onmessage = co(function* (data) {
  const userId = data.user.id
  const unlock = yield this.lock(userId)
  try {
    yield this._processIncoming(data)
  } finally {
    debug(`failed to process incoming message from ${userId}`)
    try {
      const sendQueue = this.getCurrentRequest(userId).sendQueue.slice()
      this._deleteCurrentRequest(data)
      const n = sendQueue.length
      if (n) {
        debug(`processing ${n} items in send queue to ${userId}`)
        yield series(sendQueue, opts => this.rawSend(opts))
      }
    } finally {
      unlock()
    }
  }
})

proto._processIncoming = co(function* (data) {
  const { state, models } = this
  // make a defensive copy
  data = shallowClone(data)
  if (!data.object && data.payload) {
    data.object = data.payload
  }

  data.models = models
  const { user, type } = data
  const model = models.all[type]
  // init is non-destructive
  state.init(user)
  state.deduceCurrentApplication(data)
  this._setRequest(data)

  let applicationPreviousVersion
  let { application } = data
  if (application) {
    // lookup current application state
    data.application = yield this.getApplicationByStub(application);
    ({ application } = data)
    applicationPreviousVersion = clone(application)
  }

  yield this._exec('onmessage', data)
  yield this._exec(`onmessage:${type}`, data)
  if (model.subClassOf) {
    yield this._exec(`onmessage:${model.subClassOf}`, data)
  }

  ({ application } = data)
  if (!application || deepEqual(application, applicationPreviousVersion)) {
    return
  }

  if (applicationPreviousVersion) {
    application = yield this._createNewVersionOfApplication(application)
  }

  yield this.saveApplication({ user, application })
})

proto._createNewVersionOfApplication = function (application) {
  application = toNewVersion(application)
  this.state.updateApplication({
    application,
    properties: { dateModified: Date.now() }
  })

  return this.bot.sign(application)
}

proto.getApplicationByStub = function ({ statePermalink }) {
  return this.getApplication(statePermalink)
}

proto.getApplication = function (permalink) {
  return this.bot.db.latest({
    type: this.models.private.application.id,
    permalink
  })
}

proto._noComprendo = function ({ user, type }) {
  const model = this.models.all[type]
  const title = model ? model.title : type
  return this.send(user, format(STRINGS.NO_COMPRENDO, title))
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

proto.rawSend = function ({ user, object, other={} }) {
  const to = user.id || user
  debug(`sending ${object[TYPE]} to ${to}`)
  return this.bot.send({ to, object, other })
}

proto.send = co(function* (opts) {
  opts = shallowClone(opts)
  let { user, object, other={}, application } = opts
  if (typeof object === 'string') {
    object = createSimpleMessage(object)
  }

  if (!object[SIG]) {
    object = opts.object = yield this.sign(object)
  }

  const req = this.getCurrentRequest(user)
  if (!application && req) {
    application = req.application
  }

  if (application) {
    other.context = this.state.getApplicationContext(application)
  }

  if (req) {
    debug(`queueing send to ${user.id}`)
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

proto.continueApplication = co(function* (data) {
  const { application } = data
  if (!application) return

  const requested = yield this.requestNextRequiredItem(data)
  if (!requested) {
    yield this._exec('onFormsCollected', data)
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

proto.verify = co(function* ({ user, object, verification={} }) {
  const { bot, state } = this
  if (typeof user === 'string') {
    user = yield bot.users.get(user)
  }

  const unsigned = state.createVerification({ user, object, verification })
  verification = yield this.send({ user, object: unsigned })
  state.addVerification({ user, object, verification })
  return verification
})

proto.approve =
proto.issueCertificate = co(function* ({ user, application }) {
  const unsigned = this.state.createCertificate({ application })
  const certificate = yield this.send({ user, object: unsigned })
  const certState = this.state.addCertificate({ user, application, certificate })
  return certificate
})

// proto.revokeCertificate = co(function* ({ user, application, certificate }) {
//   if (!application) {
//     application = user.certificates.find(app => {
//       return app.certificate._link === certificate._link
//     })
//   }

//   this.state.revokeCertificate({ user, application })
//   return this.send(user, application.certificate)
// })

// promisified because it might be overridden by an async function
proto.getNextRequiredItem = co(function* ({ application }) {
  const { models } = this
  const productModel = models.all[application.requestFor]
  const required = yield this._exec({
    method: 'getRequiredForms',
    args: [{ application, productModel }],
    returnResult: true
  })

  return required.find(form => {
    return application.forms.every(({ type }) => type !== form)
  })
})

proto.requestNextRequiredItem = co(function* ({ user, application }) {
  const next = yield this.getNextRequiredItem({ user, application })
  if (!next) return false

  yield this.requestItem({ user, application, item: next })
  return true
})

// promisified because it might be overridden by an async function
proto.requestItem = co(function* ({ user, application, item }) {
  const product = application.requestFor
  const context = parseId(application.request.id).permalink
  debug(`requesting ${item} from user ${user.id} for product ${product}`)
  const reqItem = yield this.createItemRequest({ user, application, product, item })
  yield this.send({ user, object: reqItem, other: { context } })
  return true
})

// promisified because it might be overridden by an async function
proto.createItemRequest = co(function* ({ user, application, product, item }) {
  const req = {
    [TYPE]: 'tradle.FormRequest',
    form: item
  }

  if (!product && application) {
    product = application.requestFor
  }

  if (product) req.requestFor = product

  yield this._exec('willRequestForm', {
    application,
    form: item,
    formRequest: req,
    user,
    // compat with tradle/tim-bank
    state: user
  })

  return req
})

proto.sendProductList = co(function* ({ user }) {
  const item = this.models.biz.productRequest.id
  const productChooser = yield this.createItemRequest({ item })
  return this.send({ user, object: productChooser })
})

proto.requestEdit = co(function* ({ user, object, message, errors=[] }) {
  if (!message && errors.length) {
    message = errors[0].error
  }

  debug(`requesting edit for form ${object[TYPE]}`)
  yield this.send({
    user,
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

function newRequestState (data) {
  return {
    application: data.application,
    sendQueue: [],
  }
}
