const { TYPE, SIG } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const {
  co,
  isPromise,
  format,
  shallowExtend,
  shallowClone,
  debug,
  validateRequired,
  createSimpleMessage
} = require('./utils')

const Commander = require('./commander')
const STRINGS = require('./strings')
const REMEDIATION = 'tradle.Remediation'
const VERIFICATION = 'tradle.Verification'
const APPROVAL = 'tradle.ApplicationApproval'
const DENIAL = 'tradle.ApplicationDenial'
const PRODUCT_REQUEST = 'tradle.ProductRequest'
const TO_SEAL = [
  VERIFICATION.
  CONFIRMATION,
  APPROVAL,
  DENIAL
]

module.exports = function (api) {
  const { models, plugins, state } = api
  const bizModels = models.biz
  const commands = new Commander(api)
  const handleApplication = co(function* (req) {
    const { user, object } = req
    const { requestFor } = object

    debug(`received application for "${requestFor}"`)
    const isOfferedProduct = bizModels.products.includes(requestFor)
    if (!isOfferedProduct) {
      debug(`ignoring application for "${requestFor}" as it's not in specified offering`)
      return
    }

    const pending = state.getApplicationsByType(user.applications, requestFor)
    if (pending.length) {
      yield plugins.exec({
        method: 'onPendingApplicationCollision',
        args: [{ req, pending }]
      })

      return
    }

    if (req.application) {
      // ignore and continue existing application
      //
      // delegate this decision to the outside?
      yield this.continueApplication(req)
      return
    }

    const existingProduct = user.applicationsApproved.find(application => {
      return application.requestFor === object.requestFor
    })

    if (existingProduct) {
      const maybePromise = plugins.exec({
        method: 'onRequestForExistingProduct',
        args: [req]
      })

      if (isPromise(maybePromise)) yield maybePromise
      return
    }

    yield api.addApplication({ req })
  })

  const onPendingApplicationCollision = co(function* ({ req, pending }) {
    req.application = yield this.getApplicationByStub(pending[0])
    req.context = req.application.context
    debug(`ignoring 2nd request for ${req.application.requestFor}, one is already pending: ${req.application._permalink}`)
    yield this.continueApplication(req)
  })

  const onRequestForExistingProduct = co(function* (req) {
    // to allow the 2nd application, uncomment:
    // yield api.addApplication({ req })

    const type = req.object.requestFor
    const model = models.all[type]
    yield api.send({
      req,
      object: format(STRINGS.ALREADY_HAVE_PRODUCT, model.title)
    })
  })

  const handleForm = co(function* (req) {
    debug('handleForm start')
    const { application, object, type } = req
    if (!application) {
      debug('application is unknown, ignoring form')
      return
    }

    if (type === PRODUCT_REQUEST) {
      debug('handleForm', `ignoring ${type} as it's handled by handleApplication`)
      // handled by handleApplication
      return
    }

    if (application && application.requestFor === REMEDIATION) return

    debug('handleForm:validateForm')
    let err = plugins.exec({
      method: 'validateForm',
      args: [{
        application,
        form: object,
        returnResult: true
      }]
    })

    if (isPromise(err)) err = yield err

    if (err) {
      debug('handleForm:requestEdit')
      yield this.requestEdit({ req, details: err })
      return
    }

    debug('handleForm: addForm, continueApplication')
    this.state.addForm(req)
    yield this.continueApplication(req)
  })

  function validateForm ({ application, form }) {
    const type = form[TYPE]
    const model = models.all[type]
    if (!model) throw new Error(`unknown type ${type}`)

    let err = validateRequired({ model, resource: form })
    if (!err) {
      if (!form[SIG]) {
        err = {
          message: 'Please review',
          errors: []
        }
      }
    }

    return err
  }

  const handleVerification = co(function* (req) {
    this.state.importVerification(req)
    yield this.continueApplication(req)
  })

  function saveIdentity ({ user, object }) {
    this.state.setIdentity({ user, identity: object.identity })
  }

  const saveName = co(function* (req) {
    const { user, object, application } = req
    if (!object.profile) return

    const { firstName } = user
    this.state.setProfile({ user, object })
    if (user.firstName !== firstName) {
      yield this.send({
        req,
        object: createSimpleMessage(format(STRINGS.HI_JOE, user.firstName))
      })
    }

    // if (user.firstName) {
    //   application.firstName = user.firstName
    // }

    // if (user.lastName) {
    //   application.lastName = user.lastName
    // }
  })

  function sendApplicationSubmitted (req) {
    const { application } = req
    const message = application.dateCompleted
      ? STRINGS.APPLICATION_UPDATED
      : STRINGS.APPLICATION_SUBMITTED

    return this.send({
      req,
      object: createSimpleMessage(message)
    })
  }

  const handleSimpleMessage = co(function* (req) {
    const message = req.message.object.message.trim().toLowerCase()
    if (message[0] === '/') {
      return plugins.exec({
        method: 'onCommand',
        args: [{ req, command: message }]
      })
    }

    // return banter(req)
  })

  // const banter = co(function* (req) {
  //   const { object } = req
  //   const tellMeMore = format(STRINGS.TELL_ME_MORE, object.message)
  //   yield this.send({
  //     req,
  //     object: createSimpleMessage(STRINGS.DONT_UNDERSTAND)
  //   })
  // })

  function willRequestForm ({ formRequest }) {
    const model = models.all[formRequest.form]
    let message
    if (model.id === PRODUCT_REQUEST) {
      message = STRINGS.PRODUCT_LIST_MESSAGE
    } else if (model.subClassOf === 'tradle.Form') {
      message = format(STRINGS.PLEASE_FILL_FORM, model.title)
    } else {
      message = STRINGS.PLEASE_GET_THIS_PREREQUISITE_PRODUCT
    }

    formRequest.message = message
  }

  function setCompleted ({ application }) {
    this.state.setApplicationStatus({ application, status: 'completed' })
  }

  function shouldSealReceived ({ message, object }) {
    const type = object[TYPE]
    const model = models.all[type]
    if (model && model.subClassOf === 'tradle.Form') {
      return true
    }
  }

  function shouldSealSent ({ message, object }) {
    const type = object[TYPE]
    if (TO_SEAL.includes(type)) return true

    const model = models.all[type]
    if (model && model.subClassOf === 'tradle.MyProduct') {
      return true
    }
  }

  const didSend = co(function* (...args) {
    const should = yield api._exec({
      method: 'shouldSealSent',
      args,
      allowExit: true,
      returnResult: true
    })

    if (!should) return

    const [sendInput, sendOutput] = args
    const object = sendOutput
    const link = buildResource.link(object)
    const sealOpts = shallowClone(sendInput, { link, object })
    yield api.seal(sealOpts)
  })

  const willSend = co(function* (opts) {
    const { req, to, link, object } = opts
    if (!to) opts.to = req.user
    if (link && !object) {
      opts.object = yield this.bot.objects.get(link)
    }
  })

  function deduceApplication (data) {
    const { user, context, type } = data
    if (type === PRODUCT_REQUEST) return

    const { applications=[], applicationsApproved=[] } = user
    let application
    if (context) {
      application = state.getApplicationByContext(applications, context) ||
        state.getApplicationByContext(applicationsApproved, context)

      if (!application) {
        debug(`application with context ${context} not found`)
      }
    } else {
      application = state.guessApplicationFromIncomingType(applications, type) ||
        state.guessApplicationFromIncomingType(applicationsApproved, type)

      if (applicationsApproved.some(appState => appState === application)) {
        // nasty side effect
        data.forCertificate = true
      }
    }

    if (application) {
      debug('deduced current application, context: ' + application.context)
    } else {
      debug(`could not deduce current application`)
    }

    return application
  }

  const defaults = {
    onCommand: commands.exec.bind(commands),
    deduceApplication,
    willSend,
    didSend,
    shouldSealSent,
    shouldSealReceived,
    getRequiredForms,
    validateForm,
    willRequestForm,
    onPendingApplicationCollision,
    onRequestForExistingProduct,
    onFormsCollected: [
      sendApplicationSubmitted,
      setCompleted,
      // api.approveApplication
    ]
  }

  shallowExtend(defaults, prependKeysWith('onmessage:', {
    'tradle.SelfIntroduction': [
      saveIdentity,
      saveName,
      api.sendProductList
    ],
    'tradle.IdentityPublishRequest': [
      saveIdentity,
      saveName,
      api.sendProductList
    ],
    // 'tradle.Name': saveName,
    'tradle.Form': handleForm,
    'tradle.Verification': handleVerification,
    'tradle.ProductRequest': handleApplication,
    'tradle.SimpleMessage': handleSimpleMessage,
    'tradle.CustomerWaiting': api.sendProductList,
    'tradle.ForgetMe': api.forgetUser,
    // onUnhandledMessage: noComprendo
  }))

  return defaults
}

function prependKeysWith (prefix, obj) {
  const copy = {}
  for (let key in obj) {
    copy[prefix + key] = obj[key]
  }

  return copy
}

// promisified because it might be overridden by an async function
function getRequiredForms ({ req, productModel }) {
  return productModel.forms.slice()
}
