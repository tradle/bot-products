const { EventEmitter } = require('events')
const inherits = require('inherits')
const _ = require('lodash')
const typeforce = require('typeforce')
const validateResource = require('@tradle/validate-resource')
const { omitVirtual, getRef, getResourceIdentifier, pickBacklinks, omitBacklinks } = validateResource.utils
const buildResource = require('@tradle/build-resource')
const { TYPE, SIG, PREVLINK, PERMALINK } = require('@tradle/constants')
const ModelManager = require('./models')
const stateModels = require('./state-models')
const Errors = require('./errors')
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
  getVerificationPermalinks,
  getPermalinkFromResourceOrStub,
  allSettledSuccesses
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

const APPLICATION_METHODS = [
  { name: 'approveApplication' },
  { name: 'denyApplication' },
  { name: 'verify' },
  { name: 'issueVerifications' },
  { name: 'requestNextRequiredItem' },
  { name: 'requestEdit' },
  { name: 'continueApplication' },
  { name: 'sendIssuedVerifications', preprocess: '_resolveApplication' }
]

exports = module.exports = opts => new Provider(opts)

function Provider (opts) {
  EventEmitter.call(this)
  bindAll(this)
  applicationMixin(this)

  const {
    bot,
    models,
    products,
    logger=defaultLogger,
    queueSends=true,
    validateModels=true,
    nullifyToDeleteProperty
  } = opts

  this.bot = bot
  this.models = new ModelManager({ products, validate: validateModels })
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

  APPLICATION_METHODS.forEach(({
    name,
    preprocess='_resolveApplicationAndApplicant'
  }) => {
    const fn = this[name]
    this[name] = co(function* (opts) {
      opts = yield this[preprocess](opts)
      return fn.call(this, opts)
    }).bind(this)
  })

  triggerBeforeAfter(this, [
    'send',
    'sign',
    'seal',
    'save',
    'verify',
    'approveApplication',
    'denyApplication',
    'saveNewVersionOfApplication',
    'saveApplication'
  ])

  this._queueSends = queueSends
  this._nullifyToDeleteProperty = nullifyToDeleteProperty

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
  let { user, application } = req
  const before = req[BEFORE_PROP]
  const applicant = getApplicantFromRequest(req)
  const applicantIsSender = isApplicantSender(req)
  const changes = []
  if (this._shouldSaveChange(before.application, application)) {
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

  if (!applicantIsSender && this._shouldSaveChange(before.applicant, applicant)) {
    this.logger.debug('saving applicant state', {
      applicant: applicant.id
    })

    changes.push(bot.users.merge(applicant))
  }

  if (this._shouldSaveChange(before.user, user, stateModels.customer)) {
    this.logger.debug('saving message sender state', {
      user: user.id
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
  const applicantPermalink = getPermalinkFromResourceOrStub(application.applicant)
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

proto.getApplication = co(function* (application) {
  const models = this.models.all

  if (application[SIG] && _.some(this._pickBacklinks(application), arr => arr.length)) {
    return application
  }

  let identifier
  if (typeof application === 'string') {
    identifier = { type: APPLICATION, permalink: application }
  } else {
    identifier = getResourceIdentifier(application)
  }

  let getApp
  if (application[TYPE]) {
    // add backlinks
    getApp = this.bot.getResource(application, { backlinks: true })
  } else if (typeof application === 'string') {
    getApp = this.bot.getResource({
      type: APPLICATION,
      permalink: application
    }, { backlinks: true })
  } else {
    getApp = this.getApplicationByStub(application)
  }

  const getSubs = this.bot.db.find({
    filter: {
      EQ: {
        [TYPE]: 'tradle.ApplicationSubmission',
        'application.permalink': identifier.permalink
      }
    }
  })

  application = yield getApp
  application.submissions = (yield getSubs).items
  this.state.organizeSubmissions(application)
  return application
})

proto.getApplicationAndApplicant = co(function* ({ applicant, application }) {
  const applicationPromise = application
    ? this.getApplication(application)
    : Promise.resolve(null)

  if (typeof applicant === 'string') {
    applicant = yield this.bot.getResource({
      type: stateModels.customer,
      permalink: applicant
    })
  } else if (!applicant) {
    applicant = yield applicationPromise.then(application => {
      if (!application) throw new Error('unable to resolve "applicant" argument')

      return this.bot.users.get(getPermalinkFromResourceOrStub(application.applicant))
    })
  }

  application = yield applicationPromise
  return { applicant, application }
})

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

proto.rawSendBatch = co(function* ({ messages }) {
  this.logger.debug(`sending batch of ${messages.length} messages`)
  return yield this.bot.send(messages)
})

proto.rawSend = co(function* ({ to, link, object, other={} }) {
  this.logger.debug(`sending ${object ? object[TYPE] : link} to ${to}`)
  return yield this.bot.send({ to, link, object, other })
})

// accept "req" or params to "seal"
proto.seal = co(function* (opts) {
  const {
    // req
    user,
    payload,
    // seal opts
    counterparty,
    object,
    link
  } = opts

  return yield this.bot.seal({
    counterparty: counterparty || user.id,
    object: object || payload,
    link
  })
})

proto.reply = co(function* (req, replyObj) {
  const { user, application } = req
  if (!user) {
    throw new Error('req is missing "user" property')
  }

  return yield this.send(_.extend({
    req,
    to: user,
    application
  }, replyObj))
})

proto.sendSimpleMessage = co(function* (opts) {
  const { message } = opts
  opts = _.omit(opts, ['message'])
  opts.object = createSimpleMessage(message)
  return yield this.send(opts)
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

proto._pickBacklinks = function (resource, model) {
  return pickBacklinks({
    model: model || this.models.all[resource[TYPE]],
    resource
  })
}

proto._omitBacklinks = function (resource, model) {
  return omitBacklinks({
    model: model || this.models.all[resource[TYPE]],
    resource
  })
}

proto._shouldSaveChange = function (before, after, model) {
  if (!after) return false
  if (!before) return true

  if (before._permalink === after._permalink) {
    if (!_.isEqual(this._omitBacklinks(after, model), this._omitBacklinks(before, model))) {
      debugger
      return true
    }
  }
}

proto.sign = co(function* (object) {
  if (typeof object === 'string') {
    object = createSimpleMessage(object)
  }

  const signed = yield this.bot.sign(this._omitBacklinks(object))
  const link = buildResource.link(signed)
  buildResource.setVirtual(signed, {
    _link: link,
    _permalink: signed[PERMALINK] || link
  })

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

  this.state.addSubmission({ application, submission: verification })
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

proto.addApplication = co(function* ({ req }) {
  const { user } = req
  const application = this.state.createApplication(req)
  yield this._exec('willCreateApplication', { req, user, application })
  req.application = yield this.sign(application)
  this.state.addApplication(req)
  yield this._exec('didCreateApplication', { req, user, application: req.application })
  yield this.continueApplication(req)
})

proto.version = co(function* (object) {
  return yield this.bot.createNewVersion(object)
})

proto.save = co(function* (signedObject) {
  return yield this.bot.save(signedObject)
})

proto.signAndSave = co(function* (object) {
  const signed = yield this.sign(object)
  yield this.save(signed)
  return signed
})

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
  const applications = yield allSettledSuccesses(applicationPermalinks.map(_permalink => {
    return db.get({
      [TYPE]: APPLICATION,
      _permalink
    })
  }))

  const formsAndVerifications = applications.reduce((all, application) => {
    const { forms=[], verifications=[] } = application
    const stubs = forms
      .concat(verifications)
      .map(appSub => appSub.submission)

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
    // indicate that these properties should be deleted
    if (this._nullifyToDeleteProperty) {
      user[propertyName] = null
    } else {
      delete user[propertyName]
    }
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
  const { bot, state } = this
  this.logger.debug('verifying', {
    type: object[TYPE] || parseStub(object).type,
    user: user && user.id,
    application: application._permalink,
    sending: !!send
  })

  const unsigned = yield state.createVerification({ application, object, verification })
  if (send) {
    return yield this.send({ req, to: user, application, object: unsigned })
  }

  verification = yield this.signAndSave(unsigned)
  let appSub = this.state.createSubmission({
    application,
    submission: verification
  })

  appSub = yield this.signAndSave(appSub)
  this.state.addSubmission({ application, submission: appSub })
  return verification
})

proto.denyApplication = co(function* ({ req, user, application, judge }) {
  if (application.status === this.state.status.denied) {
    throw new Errors.Duplicate('already denied')
  }

  this.logger.debug(`denying application`, {
    deniedBy: judge && judge.id,
    product: application.requestFor,
    user: user.id
  })

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

// proto.sendIssuedVerifications = co(function* ({ req, to, application }) {
//   const { verifications=[] } = application
//   yield verificationsIssued.map(({ link }) => this.send({ req, to, application, link }))
// })

// proto.getUnsentVerifications = co(function* ({ application }) {
//   const { verifications=[] } = application
//   const stubs = (application.verifications || [])
//     .map(appSub => parseStub(appSub.submission))

//   const messages = yield allSettledSuccesses(stubs.map(stub => {
//     return this.bot.getMessageWithPayload({
//       select: ['_payloadLink'],
//       payloadLink: stub.link,
//       inbound: false
//     })
//   }))

//   const sent = _.chain(messages).map('_payloadLink').uniq().value()
//   return stubs.filter(stub => !sent.includes(stub.link))
// })

proto.haveAllSubmittedFormsBeenVerified = co(function* ({ application }) {
  const unverified = yield this.getUnverifiedForms({ application })
  return !unverified.length
})

proto.getUnverifiedForms = co(function* ({ application }) {
  const formStubs = (application.forms || []).map(appSub => parseStub(appSub.submission))
  const verifications = yield this.getVerifications({ application })
  const verified = verifications.map(verification => parseStub(verification.document))
  return formStubs.filter(a => !verified.find(b => a.permalink === b.permalink))
})

proto.getVerifications = co(function* ({ application }) {
  const { verifications=[] } = application
  return yield verifications.map(appSub => this.bot.getResource(appSub.submission))
})

proto.issueVerifications = co(function* ({ req, user, application, send }) {
  const unverified = yield this.getUnverifiedForms({ application })
  return yield unverified.map(formStub => this.verify({
    req,
    user,
    application,
    object: formStub,
    send
  }))
})

proto._resolveApplication = co(function* (opts, applicantProp='user') {
  opts = _.clone(opts)
  opts.application = this.getApplication(opts.application)
  return opts
})

proto._resolveApplicationAndApplicant = co(function* (opts, applicantProp='user') {
  opts = _.clone(opts)
  const { application } = opts
  const applicant = opts[applicantProp]
  const resolved = yield this.getApplicationAndApplicant({ applicant, application })
  opts.application = resolved.application
  opts[applicantProp] = resolved.applicant
  return opts
})

proto.approveApplication = co(function* ({ req, user, application, judge }) {
  if (application.status === this.state.status.approved) {
    throw new Errors.Duplicate('already approved')
  }

  this.logger.debug(`approving application`, {
    approvedBy: judge && judge.id,
    product: application.requestFor,
    user: user.id
  })

  const unsigned = this.state.createCertificate({ application })
  yield this._exec({
    method: 'willIssueCertificate',
    args: [{ user, application, certificate: unsigned, judge }]
  })

  return yield this.send({ req, to: user, application, object: unsigned })
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

proto.requestItem = co(function* ({ req, user, application, item, message, other={} }) {
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

  if (context && !other.context) {
    other.context = context
  }

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

proto.requestEdit = co(function* ({ req, user, application, item, details, other }) {
  let { message, errors=[], requestedProperties, prefill, lens } = details
  if (!message && errors.length) {
    message = errors[0].error
  }

  prefill = omitVirtual(prefill || item)
  if (!prefill[PERMALINK]) delete prefill[SIG]

  this.logger.debug(`requesting edit`, {
    for: prefill[TYPE] || prefill.id
  })

  const formError = buildResource({
    models: this.models.all,
    model: 'tradle.FormError',
    resource: {
      prefill,
      message,
      errors
    }
  })

  if (requestedProperties) {
    formError.set({ requestedProperties })
  }

  if (lens) {
    formError.set({ lens })
  }

  if (application) {
    formError.set({ context: application.context })
  }

  yield this.send({
    req,
    to: user,
    application,
    object: formError.toJSON(),
    other
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
