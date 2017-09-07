const validateResource = require('@tradle/validate-resource')
const { omitVirtual } = validateResource.utils
const buildResource = require('@tradle/build-resource')
const { TYPE, SIG, PREVLINK, PERMALINK } = require('@tradle/constants')
const createLocker = require('promise-locker')
const {
  co,
  isPromise,
  bindAll,
  format,
  omit,
  shallowClone,
  clone,
  deepEqual,
  debug,
  parseId,
  series
} = require('./utils')

const createStateMutater = require('./state')
const createPlugins = require('./plugins')
const createDefaultPlugins = require('./default-plugins')
const STRINGS = require('./strings')

module.exports = function productsStrategyImpl (opts) {
  return bot => new Strategy(bot, opts)
}

function Strategy (bot, opts) {
  bindAll(this)

  const { models } = opts
  this.bot = bot
  this.opts = opts
  this.models = models

  this._stateProps = Object.keys(models.private.customer.properties)
  this.state = createStateMutater({ models })
  this.plugins = createPlugins()
  this.plugins.setContext(this)
  this.plugins.use(createDefaultPlugins(this))
  this.uninstall = bot.onmessage(this._onmessage)
  this.lock = createLocker()
  this._sendQueues = {}
}

const proto = Strategy.prototype

proto._exec = function (method, ...args) {
  if (typeof method === 'object') {
    return Promise.resolve(this.plugins.exec(...arguments))
  }

  return Promise.resolve(this.plugins.exec({ method, args }))
}

proto._onmessage = co(function* (data) {
  const userId = data.user.id
  const unlock = yield this.lock(userId)
  this._sendQueues[userId] = []
  try {
    yield this._processIncoming(data)
  } finally {
    debug(`failed to process incoming message from ${userId}`)
    try {
      const sendQueue = this._sendQueues[userId].slice()
      const n = sendQueue.length
      if (n) {
        debug(`processing ${n} items in send queue to ${userId}`)
        yield series(sendQueue, opts => this.bot.send(opts))
      }
    } finally {
      delete this._sendQueues[userId]
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
  const { application } = data

  let applicationBefore
  if (application) {
    // lookup current application state
    data.application = yield this._getApplicationFromStub(application)
    applicationBefore = clone(data.application)
  }

  yield this._exec('onmessage', data)
  yield this._exec(`onmessage:${type}`, data)
  if (model.subClassOf) {
    yield this._exec(`onmessage:${model.subClassOf}`, data)
  }

  if (applicationBefore && !deepEqual(data.application, applicationBefore)) {
    yield this._saveNewVersionOfApplication({ user, application: data.application })
  }
})

proto._saveNewVersionOfApplication = co(function* ({ user, application }) {
  const newVersion = toNewVersion(application)
  this.state.updateApplication({
    application: newVersion,
    properties: { dateModified: Date.now() }
  })

  const signed = yield this.bot.sign(newVersion)
  debug(`saving updated application for ${user.id}`)
  this.state.updateApplicationStub({ user, application: newVersion })
  yield this.bot.save(signed)
})

proto._getApplicationFromStub = function ({ statePermalink }) {
  return this._getApplication(statePermalink)
}

proto._getApplication = function (permalink) {
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

// Public API
proto.removeDefaultHandlers = function () {
  this.plugins.remove(this._defaultPlugins)
}

proto.removeDefaultHandler = function (method) {
  const handler = this._defaultPlugins[method]
  this.plugins.remove(method, handler)
  return handler
}

proto.send = co(function* (user, object, other={}) {
  const to = user.id || user
  const opts = { to, object, other }
  if (this._sendQueues[to]) {
    this._sendQueues[to].push(opts)
  } else {
    yield this.bot.send(opts)
  }
})

proto.sign = co(function* (object) {
  const signed = yield this.bot.sign(object)
  const link = buildResource.link(signed)
  buildResource.setVirtual(signed, {
    _link: link,
    _permalink: signed[PERMALINK] || link
  })

  return signed
})

proto.save = function save (signedObject) {
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
    const maybePromise = this._exec('onFormsCollected', data)
    if (isPromise(maybePromise)) yield maybePromise
  }
})

proto.forgetUser = function ({ user }) {
  this._stateProps.forEach(prop => {
    delete user[prop]
  })

  this.state.init(user)
}

proto.verify = co(function* ({ user, object, verification={} }) {
  const { bot, state } = this
  if (typeof user === 'string') {
    user = yield bot.users.get(user)
  }

  const unsigned = state.createVerification({ user, object, verification })
  verification = yield this.sign(unsigned)
  state.addVerification({ user, object, verification })
  yield this.send(user, verification)
  return verification
})

proto.issueCertificate = co(function* ({ user, application }) {
  const unsigned = this.state.createCertificate({ application })
  const certificate = yield this.sign(unsigned)
  const certState = this.state.addCertificate({ user, application, certificate })
  const context = this.state.getApplicationContext(certState)
  yield this.send(user, certificate, { context })
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
  yield this.send(user, reqItem, { context })
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

  const ret = this._exec('willRequestForm', {
    application,
    form: item,
    formRequest: req,
    user,
    // compat with tradle/tim-bank
    state: user
  })

  if (isPromise(ret)) yield ret

  return req
})

proto.sendProductList = co(function* ({ user }) {
  const item = this.models.biz.productRequest.id
  const productChooser = yield this.createItemRequest({ item })
  return this.send(user, productChooser)
})

proto.requestEdit = co(function* ({ user, object, message, errors=[] }) {
  if (!message && errors.length) {
    message = errors[0].error
  }

  debug(`requesting edit for form ${object[TYPE]}`)
  yield this.send(user, {
    _t: 'tradle.FormError',
    prefill: omit(object, '_s'),
    message,
    errors
  })
})

function toNewVersion (object) {
  const newVersion = clone(object)
  delete newVersion[SIG]
  newVersion[PREVLINK] = buildResource.link(object)
  newVersion[PERMALINK] = buildResource.permalink(object)
  return omitVirtual(newVersion, ['_link'])
}
