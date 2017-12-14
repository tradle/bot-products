const { EventEmitter } = require('events')
const typeforce = require('typeforce')
const inherits = require('inherits')
const validateResource = require('@tradle/validate-resource')
const { omitVirtual, getRef } = validateResource.utils
const buildResource = require('@tradle/build-resource')
const { TYPE, SIG, PREVLINK, PERMALINK } = require('@tradle/constants')
const ModelManager = require('./models')
const {
  co,
  bindAll,
  omit,
  clone,
  deepEqual,
  debug,
  parseId,
  parseStub,
  series,
  hashObject,
  modelsToArray,
  createSimpleMessage,
  getRequestContext,
  isPromise,
  deleteAllVersions,
  getApplicationPermalinks,
  getVerificationPermalinks
} = require('./utils')

const createStateMutater = require('./state')
const createPlugins = require('./plugins')
const createDefaultPlugins = require('./default-plugins')
const STRINGS = require('./strings')
const createDefiner = require('./definer')
const triggerBeforeAfter = require('./trigger-before-after')
const applicationMixin = require('./application-mixin')
const {
  DENIAL,
  APPLICATION,
  VERIFICATION,
  FORGOT_YOU,
  FORM_REQUEST,
  PRODUCT_REQUEST,
  IDENTITY
} = require('./types')

const HISTORY_OPTS = {
  inbound: 3,
  outbound: 3,
  maxLength: 10
}

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

exports = module.exports = opts => new Provider(opts)

function Provider (opts) {
  EventEmitter.call(this)
  bindAll(this)
  applicationMixin(this)

  const {
    namespace,
    models,
    products,
    queueSends=true,
    validateModels=true
  } = opts

  this.namespace = namespace
  this.models = new ModelManager({ namespace, products, validate: validateModels })
  this._stateProps = Object.keys(this.models.private.customer.properties)
  this._forgettableProps = this._stateProps.filter(prop => {
    return prop !== 'identity' && prop !== 'id' && prop !== TYPE
  })

  this.plugins = createPlugins()
  this._define = createDefiner()
  // be lazy
  this._define('_modelsArray', () => modelsToArray(this.models.all))
  this._define('_latestModelsHash', () => hashObject(this._modelsArray))
  Object.defineProperty(this, 'products', {
    get () {
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

  this._queueSends = queueSends

  // ;['send', 'rawSend', 'sign'].forEach(method => {
  //   this[method] = (...args) => this._exec(method, ...args)
  //   this._hooks.hook('_' + method, this['_' + method])
  // })
}

inherits(Provider, EventEmitter)
const proto = Provider.prototype

proto.install = function (bot) {
  this.bot = bot
  this.uninstall = bot.onmessage(this._onmessage)
  this.emit('bot', bot)
  return this
}

proto.addProducts = function addProducts ({ models, products }) {
  this.models.addProducts({ models, products })
  this.state = createStateMutater({ models: this.models })
  this.removeDefaultHandlers()
  this._defaultPlugins = createDefaultPlugins(this)
  this.plugins.use(this._defaultPlugins)

  // don't use delete, need to trigger set() to clear the cached value
  this._modelsArray = undefined
  this._latestModelsHash = undefined

  return this
}

// proto.addPrivateModels = (models) => {
//   shallowExtend(this.models.private.all, models)
//   this.models.all = mergeModels()
//     .add(this.models.all)
//     .add(this.models.private.all)
// }

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

proto._updateHistorySummary = co(function* ({
  req,
  user,
  message,
  object,
  inbound,
  label
}) {
  if (!user) user = req.user
  if (!object) object = req.object
  if (!label) {
    label = this.plugins.exec({
      method: 'getMessageLabel',
      args: [{ user, object, message, inbound }],
      returnResult: true
    })

    if (isPromise(label)) label = yield label
  }

  const type = object[TYPE]
  const { historySummary=[] } = user
  const item = { type }
  if (inbound) item.inbound = inbound
  if (label) item.label = label

  historySummary.push(item)

  while (historySummary.length > HISTORY_OPTS.maxLength) {
    historySummary.shift()
  }

  user.historySummary = historySummary
})

proto._onmessage = co(function* (data) {
  const req = this.state.newRequestState(data)
  const { user } = data
  const { state, models } = this
  if (!user.identity) {
    try {
      const identity = yield this.bot.addressBook.byPermalink(user.id)
      state.setIdentity({ user, identity })
    } catch (err) {
      debug(`don't have user's identity!`)
    }
  }

  req.models = models
  req.context = getRequestContext({ req, models: models.all })
  this._updateHistorySummary({ req, inbound: true })

  // make a defensive copy
  const userId = data.user.id
  try {
    yield this._processIncoming(req)
  } catch (err) {
    debug(`failed to process incoming message from ${userId}`, err)
    throw err
  } finally {
    try {
      yield this._exec('didReceive', req)
    } catch (err) {
      debug('didReceive failed', err.stack)
    }

    if (req.sendQueue.length) {
      yield this.rawSendBatch({ req, messages: req.sendQueue })
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
  debug(`processing incoming ${type}, context: ${req.context}`)

  state.init(user)
  const deduced = yield this._execBubble('deduceApplication', req)
  if (deduced) {
    req.application = deduced
  }

  let applicationPreviousVersion
  let { application } = req
  if (application) {
    // lookup current application state
    application = req.application = yield this.getApplicationByStub(application)
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

proto.versionAndSave = function (resource) {
  return this.bot.versionAndSave(resource)
}

proto.getApplicationByStub = function ({ id, statePermalink }) {
  if (statePermalink) {
    return this.getApplication(statePermalink)
  }

  return this.getApplication(parseId(id).permalink)
}

proto.getApplication = function (permalink) {
  return this.getResource({
    type: this.models.private.application.id,
    permalink
  })
}

proto.getResource = function ({ type, permalink }) {
  return this.bot.db.get({
    [TYPE]: type,
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

proto.rawSendBatch = function ({ req, messages }) {
  debug(`sending batch of ${messages.length} messages`)
  return this.bot.send(messages)
}

proto.rawSend = function ({ req, to, link, object, other={} }) {
  debug(`sending ${object ? object[TYPE] : link} to ${to}`)
  return this.bot.send({ to, link, object, other })
}

proto.seal = function seal (req) {
  const { link } = req
  return this.bot.seal({ link })
}

proto.send = co(function* ({ req, application, to, link, object, other={} }) {
  typeforce(types.request, req)

  if (to.id) to = to.id

  if (!application) {
    application = req.application
  }

  if (object) {
    if (!object[SIG]) {
      object = yield this.sign(object)
    }
  } else if (!link) {
    throw new Error('expected "link" or "object"')
  }

  if (!other.context && application) {
    const context = this.state.getApplicationContext(application)
    debug(`send: setting context ${context} from application ${application._permalink} for ${application.requestFor}`)
    other.context = context
  }

  debug(`send: queueing to ${to}, context: ${other.context}`)
  this._updateHistorySummary({
    req,
    object,
    inbound: false
  })

  const opts = { req, to, link, object, other }
  if (req.message && this._queueSends !== false) {
    // this request is based on an incoming message
    // so we can try to batch the sends at the end (maybe)
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

proto.addApplication = co(function* ({ req }) {
  req.application = yield this.sign(this.state.createApplication(req))
  this.state.addApplication(req)
  yield this.continueApplication(req)
})

proto.version = function (object) {
  return this.bot.createNewVersion(object)
}

proto.save = function (signedObject) {
  return this.bot.save(signedObject)
}

proto.signAndSave = co(function* (object) {
  const signed = yield this.sign(object)
  yield this.save(signed)
  return signed
})

proto.importVerification = function ({ req, user, application, verification }) {
  if (!user) user = req.user
  if (!application) application = req.application
  if (!verification) verification = req.object
  this.state.importVerification({ user, application, verification })
}

proto.continueApplication = co(function* (req) {
  debug('continueApplication')
  const { application } = req
  if (!application) return

  const requested = yield this.requestNextRequiredItem(req)
  if (!requested) {
    yield this._exec('onFormsCollected', req)
  }
})

proto.forgetUser = co(function* (req) {
  const { user } = req
  debug(`forgetUser: clearing user state for ${user.id}: ${this._forgettableProps.join(', ')}`)

  const { bot, models } = this
  const { db } = bot
  const applicationPermalinks = getApplicationPermalinks({ user, models })
  const applications = yield applicationPermalinks.map(_permalink => {
    return db.get({
      [TYPE]: APPLICATION,
      _permalink
    })
  })

  const formsAndVerifications = applications.reduce((all, application) => {
    const { forms=[], verificationsIssued=[], verificationsImported=[] } = application
    const verifications = verificationsIssued
      .concat(verificationsImported)
      .map(({ item }) => item)

    const stubs = forms.concat(verifications)
    return all.concat(stubs.map(parseStub))
  }, [])

  const deleteFormsAndVerifications = Promise.all(formsAndVerifications.map(({ type, permalink }) => {
    debug(`forgetUser: deleting form ${type}: ${permalink}`)
    return db.del({
      [TYPE]: type,
      _permalink: permalink
    })
  }))

  // don't delete the applications themselves
  const markForgottenApplications = Promise.all(applications.map(application => {
    debug(`forgetUser: archiving application for ${application.requestFor}: ${application._permalink} `)
    application.archived = true
    return this.saveNewVersionOfApplication({ user, application })
  }))

  yield [
    deleteFormsAndVerifications,
    markForgottenApplications
  ]

  this._forgettableProps.forEach(propertyName => {
    delete user[propertyName]
  })

  this.state.init(user)
  return this.send({
    req,
    object: buildResource({
        models: this.models.all,
        model: FORGOT_YOU
      })
      .set('message', STRINGS.SORRY_TO_FORGET_YOU)
      .toJSON()
  })
})

proto.verify = co(function* ({ req, user, application, object, verification={}, send }) {
  if (!user) user = req.user
  if (!object) object = req.object
  if (!application) application = req.application

  if (!(user && object && application)) {
    throw new Error('expected "user", "object", and "application"')
  }

  const { bot, state } = this
  if (typeof user === 'string') {
    user = yield bot.users.get(user)
  }

  debug(`verifying ${object[TYPE]} of user ${user.id} for application ${application._permalink}`)
  debug(`sending verification to user right away: ${!!send}`)

  const unsigned = state.createVerification({ req, application, object, verification })
  if (send) {
    verification = yield this.send({ req, object: unsigned })
  } else {
    verification = yield this.sign(unsigned)
    yield bot.save(verification)
  }

  state.addVerification({ user, application, object, verification })
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

  this.state.setApplicationStatus({
    application,
    status: this.state.status.denied
  })

  this.state.moveToDenied({ user, application })
  return this.send({ req, to: user, object: denial })
})

proto.sendIssuedVerifications = co(function* ({ req, to, application }) {
  const { verificationsIssued=[] } = application
  yield verificationsIssued.map(({ link }) => this.send({ req, to, link }))
})

proto.haveAllSubmittedFormsBeenVerified = function ({ application }) {
  const { forms=[], verificationsIssued=[] } = application
  return forms.every(form => {
    return verificationsIssued.find(({ item }) => {
      return item.id === form.id
    })
  })
}

proto.issueVerifications = co(function* ({ req, user, application, send }) {
  if (req) {
    if (!user) user = req.user
    if (!application) application = req.application
  } else {
    req = this.state.newRequestState({ user })
  }

  const {
    forms,
    verificationsImported=[],
    verificationsIssued=[]
  } = application

  const unverified = forms.filter(form => {
    return !verificationsIssued.find(({ item }) => item.id === form.id)
  })

  return yield unverified.map(formStub => this.verify({
    req,
    user,
    application,
    object: formStub,
    send
  }))
})

proto.approveApplication = co(function* ({ req, user, application }) {
  if (!user) user = req.user
  if (!application) application = req.application

  debug(`approving application for ${application.requestFor}, for user: ${user.id}`)
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

  return this._exec({
    method: 'getNextRequiredItem',
    args: [{ req, productModel, required }],
    returnResult: true
  })
})

proto.requestNextRequiredItem = co(function* (req) {
  debug('requestNextRequiredItem')
  const next = yield this.getNextRequiredItem(req)
  if (!next) return false

  yield this.requestItem({ req, item: next })
  return true
})

// promisified because it might be overridden by an async function
proto.requestItem = co(function* ({ req, item }) {
  debug('requestItem', item)
  const { user, application } = req
  const { context, requestFor } = application
  // const context = parseId(application.request.id).permalink
  debug(`requesting ${item} from user ${user.id} for ${requestFor}`)
  const reqItem = yield this.createItemRequest({ req, requestFor, item })
  yield this.send({ req, object: reqItem, other: { context } })
  return true
})

// promisified because it might be overridden by an async function
proto.createItemRequest = co(function* ({ req, requestFor, item, chooser }) {
  debug('createItemRequest', item)
  const { user, application } = req
  const itemRequest = {
    [TYPE]: FORM_REQUEST,
    form: item,
    time: Date.now()
  }

  if (!requestFor && application) {
    requestFor = application.requestFor
  }

  if (requestFor) itemRequest.product = requestFor
  if (chooser) itemRequest.chooser = chooser
  if (req.context) itemRequest.context = req.context

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
  const productChooser = yield this.createItemRequest({
    req,
    item: PRODUCT_REQUEST,
    chooser: {
      property: 'requestFor',
      // TODO: prefill each choice with "context" property
      oneOf: this.models.biz.products.slice()
    }
  })

  return this.send({
    req,
    object: productChooser
  })
})

proto.requestEdit = co(function* ({ req, user, object, details }) {
  if (!user) user = req.user
  if (!object) object = req.object

  const { message, errors=[] } = details
  if (!message && errors.length) {
    message = errors[0].error
  }

  debug(`requesting edit for form ${object[TYPE]}`)
  const formError = buildResource({
    models: this.models.all,
    model: 'tradle.FormError',
    resource: {
      prefill: omit(object, '_s'),
      message,
      errors
    }
  })
  .toJSON()

  if (req.context) {
    formError.context = req.context
  }

  yield this.send({
    req,
    object: formError
  })
})

function normalizeExecArgs (method, ...args) {
  return typeof method === 'object'
    ? method
    : { method, args }
}
