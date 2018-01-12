const { EventEmitter } = require('events')
const inherits = require('inherits')
const _ = require('lodash')
const typeforce = require('typeforce')
const validateResource = require('@tradle/validate-resource')
const { omitVirtual, getRef } = validateResource.utils
const buildResource = require('@tradle/build-resource')
const { TYPE, SIG, PREVLINK, PERMALINK } = require('@tradle/constants')
const ModelManager = require('./models')
const stateModels = require('./state-models')
const {
  co,
  bindAll,
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

const BEFORE_PROP = '$before'
const HISTORY_OPTS = {
  inbound: 3,
  outbound: 3,
  maxLength: 10
}

const defaultLogger = {
  debug,
  log: debug,
  error: debug,
  warn: debug,
  info: debug
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
    bot,
    namespace,
    models,
    products,
    logger=defaultLogger,
    queueSends=true,
    validateModels=true
  } = opts

  this.bot = bot
  this.namespace = namespace
  this.models = new ModelManager({ namespace, products, validate: validateModels })
  this.logger = logger
  this._stateProps = Object.keys(stateModels.customer.properties)
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

// proto.install = function (bot) {
//   this.bot = bot
//   this.uninstall = bot.onmessage(this._onmessage)
//   this.emit('bot', bot)
//   return this
// }

proto.addProducts = function addProducts ({ models, products }) {
  this.models.addProducts({ models, products })
  this.state = createStateMutater(this)
  this.removeDefaultHandlers()
  this._defaultPlugins = createDefaultPlugins(this)
  this.plugins.use(this._defaultPlugins)

  // don't use delete, need to trigger set() to clear the cached value
  this._modelsArray = undefined
  this._latestModelsHash = undefined

  return this
}

// proto.addPrivateModels = (models) => {
//   _.extend(this.models.private.all, models)
//   this.models.all = mergeModels()
//     .add(this.models.all)
//     .add(this.models.private.all)
// }

proto._exec = function _exec (method, ...args) {
  const opts = normalizeExecArgs(method, ...args)
  return Promise.resolve(this.plugins.exec(opts))
}

proto._execBubble = function _execBubble (method, ...args) {
  const opts = normalizeExecArgs(method, ...args)
  opts.allowExit = true
  opts.returnResult = true
  return Promise.resolve(this.plugins.exec(opts))
}

// proto._updateHistorySummary = co(function* ({
//   req,
//   user,
//   message,
//   object,
//   inbound,
//   label
// }) {
//   if (!user) user = getApplicantFromRequest(req)
//   if (!object) object = req.object
//   if (!label) {
//     label = this.plugins.exec({
//       method: 'getMessageLabel',
//       args: [{ user, object, message, inbound }],
//       returnResult: true
//     })

//     if (isPromise(label)) label = yield label
//   }

//   const type = object[TYPE]
//   const { historySummary=[] } = user
//   const item = { type }
//   if (inbound) item.inbound = inbound
//   if (label) item.label = label

//   historySummary.push(item)

//   while (historySummary.length > HISTORY_OPTS.maxLength) {
//     historySummary.shift()
//   }

//   user.historySummary = historySummary
// })

proto.onmessage = co(function* (data) {
  const req = this.state.newRequestState(data)
  const { user } = data
  const { state, models } = this
  if (!user.identity) {
    try {
      const identity = yield this.bot.addressBook.byPermalink(user.id)
      state.setIdentity({ user, identity })
    } catch (err) {
      this.logger.error(`don't have user's identity!`)
    }
  }

  req.models = models
  req.context = getRequestContext({ req, models: models.all })
  // this._updateHistorySummary({ req, inbound: true })

  // make a defensive copy
  const userId = data.user.id
  try {
    yield this._processIncoming(req)
    yield this._saveChanges(req)
  } catch (err) {
    this.logger.error(`failed to process incoming message from ${userId}`, err)
    throw err
  } finally {
    try {
      yield this._exec('didReceive', req)
    } catch (err) {
      this.logger.error('didReceive failed', err.stack)
    }

    if (req.sendQueue.length) {
      yield this.rawSendBatch({ messages: req.sendQueue })
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
  const { bot, state, models } = this
  const { user, type } = req
  const model = models.all[type]
  // init is non-destructive
  this.logger.debug(`processing incoming`, { type, context: req.context })

  state.init(user)
  yield this._deduceApplicantAndApplication(req)

  const { applicant, application } = req
  req[BEFORE_PROP] = _.cloneDeep({
    applicant: isApplicantSender(req) ? null : applicant,
    application,
    user
  })

  let keepGoing = yield this._execBubble('onmessage', req)
  if (keepGoing === false) {
    this.logger.debug('early exit after "onmessage"')
    return
  }

  keepGoing = yield this._execBubble(`onmessage:${type}`, req)
  if (keepGoing === false) {
    this.logger.debug(`early exit after "onmessage:${type}"`)
    return
  }

  if (model.subClassOf) {
    keepGoing = yield this._execBubble(`onmessage:${model.subClassOf}`, req)
    if (keepGoing === false) {
      this.logger.debug(`early exit after "onmessage:${model.subClassOf}"`)
      return
    }
  }
})

proto._saveChanges = co(function* (req) {
  const { bot } = this
  const { user, application } = req
  const before = req[BEFORE_PROP]
  const applicant = getApplicantFromRequest(req)
  const applicantIsSender = isApplicantSender(req)
  const changes = []
  if (application && !_.isEqual(application, before.application)) {
    const saveOpts = {
      // in case it changed
      user: yield this._getApplicant(req),
      application
    }

    this.logger.debug(`saving application`, {
      application: application._permalink,
      applicant: applicant._permalink,
      new: !before.application
    })

    if (before.application) {
      changes.push(this.saveNewVersionOfApplication(saveOpts))
    } else {
      changes.push(this.saveApplication(saveOpts))
    }
  }

  if (!applicantIsSender && !_.isEqual(applicant, before.applicant)) {
    this.logger.debug('saving applicant state', {
      applicant: applicant._permalink
    })

    changes.push(bot.users.merge(applicant))
  }

  if (!_.isEqual(user, before.user)) {
    this.logger.debug('saving message sender state', {
      applicant: applicant._permalink
    })

    changes.push(bot.users.merge(user))
  }

  yield changes
})

proto._deduceApplicantAndApplication = co(function* (req) {
  const { user } = req
  let application = yield this._execBubble('deduceApplication', req)
  if (!application) return

  if (!application[SIG]) {
    application = yield this.getApplicationByStub(application)
  }

  req.application = application
  req.applicant = yield this._getApplicant(req)
})

proto._getApplicant = co(function* (req) {
  const { user, application } = req
  const applicantPermalink = parseStub(application.applicant).permalink
  if (applicantPermalink === user.id) {
    return user
  }

  return yield this.bot.users.get(applicantPermalink)
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
    type: APPLICATION,
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

  return []
}

proto.removeDefaultHandlers = function () {
  if (this._defaultPlugins) {
    this.plugins.remove(this._defaultPlugins)
  }
}

proto.rawSendBatch = function ({ messages }) {
  this.logger.debug(`sending batch of ${messages.length} messages`)
  return this.bot.send(messages)
}

proto.rawSend = function ({ to, link, object, other={} }) {
  this.logger.debug(`sending ${object ? object[TYPE] : link} to ${to}`)
  return this.bot.send({ to, link, object, other })
}

proto.seal = function seal (req) {
  const { link } = req
  return this.bot.seal({ link })
}

proto.reply = function reply (req, replyObj) {
  const { user, application } = req
  if (!user) {
    throw new Error('req is missing "user" property')
  }

  return this.send(_.extend({
    req,
    to: user,
    application
  }, replyObj))
}

proto.sendSimpleMessage = co(function* (opts) {
  const { message } = opts
  opts = _.omit(opts, ['message'])
  opts.object = createSimpleMessage(message)
  return this.send(opts)
})

proto.send = co(function* ({ req, application, to, link, object, other={} }) {
  if (!(to && (link || object))) {
    throw new Error('expected "to" and "link" or "object"')
  }

  const inReplyTo = req && req.message
  if (to.id) to = to.id

  if (!application && req) {
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
    const { context } = application
    this.logger.debug(`send: setting context`, {
      context,
      application: application._permalink,
      product: application.requestFor
    })

    other.context = context
  }

  if (!other.inReplyTo && inReplyTo) {
    const msgLink = inReplyTo._link
    if (msgLink) {
      this.logger.debug('setting reply-to on message', { inReplyTo: msgLink })
      other.inReplyTo = msgLink
    }
  }

  this.logger.debug('send: queueing', { to, context: other.context })
  // this._updateHistorySummary({
  //   req,
  //   object,
  //   inbound: false
  // })

  const opts = { req, to, link, object, other }
  if (inReplyTo && this._queueSends !== false) {
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

proto.addVerification = function ({
  user,
  application,
  verification,
  imported
}) {
  // if (!user) user = getApplicantFromRequest(req)
  // if (!application) application = req.application
  // if (!verification) verification = req.object
  // if (!(user && application && verification)) {
  //   throw new Error('expected "user", "application" and "verification"')
  // }

  this.state.addVerification({ user, application, verification, imported })
}

proto.importVerification = function importVerification (opts) {
  return this.addVerification(_.extend({
    imported: true
  }, opts))
}

proto.issueVerification = function issueVerification (opts) {
  return this.addVerification(_.extend({
    imported: false
  }, opts))
}

proto.continueApplication = co(function* (req) {
  this.logger.debug('continueApplication')
  const { user, applicant, application } = req
  if (!application) return
  // e.g. employee assigned himself as the relationship manager
  if (applicant && user.id !== applicant.id) return

  const requested = yield this.requestNextRequiredItem({ req, user, application })
  if (!requested) {
    yield this._exec('onFormsCollected', { req, user, application })
  }
})

proto.forgetUser = co(function* (req) {
  const { user } = req
  this.logger.debug('forgetUser: clearing user state', {
    user: user.id,
    props: this._forgettableProps.slice()
  })

  const { bot, models } = this
  const { db } = bot
  const applicationPermalinks = getApplicationPermalinks({ user })
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
    this.logger.debug(`forgetUser: deleting form`, { type, permalink })
    return db.del({
      [TYPE]: type,
      _permalink: permalink
    })
  }))

  // don't delete the applications themselves
  const markForgottenApplications = Promise.all(applications.map(application => {
    this.logger.debug('forgetUser: archiving application', {
      product: application.requestFor,
      application: application._permalink
    })

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
    to: user,
    object: buildResource({
        models: this.models.all,
        model: FORGOT_YOU
      })
      .set('message', STRINGS.SORRY_TO_FORGET_YOU)
      .toJSON()
  })
})

proto.verify = co(function* ({
  req,
  user,
  application,
  object,
  verification={},
  send
}) {
  if (!(user && object)) {
    throw new Error('expected "user", "object"')
  }

  const { bot, state } = this
  if (typeof user === 'string') {
    user = yield bot.users.get(user)
  }

  this.logger.debug('verifying', {
    type: object[TYPE],
    user: user.id,
    application: application._permalink,
    sending: !!send
  })

  const unsigned = yield state.createVerification({ user, application, object, verification })
  if (send) {
    verification = yield this.send({ req, to: user, application, object: unsigned })
  } else {
    verification = yield this.sign(unsigned)
    yield bot.save(verification)
  }

  if (application) {
    state.addVerification({ user, application, object, verification })
  }

  return verification
})

proto.denyApplication = co(function* ({ req, user, application }) {
  if (!(user && application)) {
    throw new Error('expected "user" and "application"')
  }

  if (application.status === this.state.status.denied) {
    this.logger(`ignoring request to deny already denied application`, {
      application: application._permalink
    })

    return
  }

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
  return this.send({ req, to: user, application, object: denial })
})

proto.sendIssuedVerifications = co(function* ({ req, to, application }) {
  const { verificationsIssued=[] } = application
  yield verificationsIssued.map(({ link }) => this.send({ req, to, application, link }))
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
  if (!(user && application)) {
    throw new Error('expected "user" and "application"')
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

proto.approveApplication = co(function* ({ req, user, application, approvedBy }) {
  if (!(user && application)) {
    throw new Error('expected "user" and "application"')
  }

  if (application.status === this.state.status.approved) {
    this.logger(`ignoring request to approve already approved application`, {
      application: application._permalink
    })

    return
  }

  this.logger.debug(`approving application`, {
    product: application.requestFor,
    user: user.id
  })

  const unsigned = this.state.createCertificate({ application })
  const certificate = yield this.send({ req, to: user, application, object: unsigned })
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
proto.getNextRequiredItem = co(function* ({ req, user, application }) {
  const { models, state } = this
  const productModel = models.all[application.requestFor]
  const required = yield this._exec({
    method: 'getRequiredForms',
    args: [{ user, application, productModel }],
    returnResult: true
  })

  return this._exec({
    method: 'getNextRequiredItem',
    args: [{ req, user, application, productModel, required }],
    returnResult: true
  })
})

proto.requestNextRequiredItem = co(function* ({ req, user, application }) {
  this.logger.debug('requestNextRequiredItem')
  const next = yield this.getNextRequiredItem({ req, user, application })
  if (!next) return false

  yield this.requestItem({ req, user, application, item: next })
  return true
})

proto.requestItem = co(function* ({ req, user, application, item, message }) {
  this.logger.debug('requestItem', item)
  const { context, requestFor } = application || {}
  const itemRequested = typeof item === 'string' ? item : item.form
  // const context = parseId(application.request.id).permalink
  this.logger.debug(`requesting`, {
    item: itemRequested,
    user: user.id,
    product: requestFor
  })

  const reqItem = yield this.createItemRequest({
    user,
    application,
    requestFor,
    item,
    message
  })

  const other = {}
  if (context) other.context = context

  yield this.send({ req, to: user, object: reqItem, other })
  return true
})

proto.createItemRequest = co(function* ({ user, application, requestFor, item, message }) {
  this.logger.debug('createItemRequest', item)
  const itemRequest = typeof item === 'string' ? { form: item } : item
  itemRequest[TYPE] = FORM_REQUEST
  if (!itemRequest.time) {
    itemRequest.time = Date.now()
  }

  if (!itemRequest.product) {
    if (!requestFor && application) {
      requestFor = application.requestFor
    }

    if (requestFor) itemRequest.product = requestFor
  }

  if (!itemRequest.context && application) {
    itemRequest.context = application.context
  }

  if (!itemRequest.message && message) {
    itemRequest.message = message
  }

  yield this._exec('willRequestForm', {
    application,
    form: item,
    formRequest: itemRequest,
    user,
    // compat with tradle/tim-bank
    state: user
  })

  return itemRequest
})

proto.sendProductList = co(function* ({ req, to }) {
  const productChooser = yield this.createItemRequest({
    user: to,
    item: {
      form: PRODUCT_REQUEST,
      chooser: {
        property: 'requestFor',
        // TODO: prefill each choice with "context" property
        oneOf: this.models.biz.products.slice()
      }
    }
  })

  return this.send({
    req,
    to,
    object: productChooser
  })
})

proto.requestEdit = co(function* ({ req, user, application, item, details }) {
  let { message, errors=[] } = details
  if (!message && errors.length) {
    message = errors[0].error
  }

  this.logger.debug(`requesting edit`, {
    for: item[TYPE]
  })

  const formError = buildResource({
    models: this.models.all,
    model: 'tradle.FormError',
    resource: {
      prefill: _.omit(omitVirtual(item), SIG),
      message,
      errors
    }
  })
  .toJSON()

  if (application) {
    formError.context = application.context
  }

  yield this.send({
    req,
    to: user,
    application,
    object: formError
  })
})

function normalizeExecArgs (method, ...args) {
  return typeof method === 'object'
    ? method
    : { method, args }
}

function getApplicantFromRequest (req) {
  return req.applicant || req.user
}

function isApplicantSender (req) {
  const { applicant, user } = req
  return !applicant || applicant.id === user.id
}
