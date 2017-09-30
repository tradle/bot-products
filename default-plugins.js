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
  getProductFromEnumValue,
  createSimpleMessage
} = require('./utils')

const STRINGS = require('./strings')
const REMEDIATION = 'tradle.Remediation'
const VERIFICATION = 'tradle.Verification'
const CONFIRMATION = 'tradle.Confirmation'
const APPROVAL = 'tradle.ApplicationApproval'
const DENIAL = 'tradle.ApplicationDenial'
const TO_SEAL = [
  VERIFICATION.
  CONFIRMATION,
  APPROVAL,
  DENIAL
]

module.exports = function (api) {
  const { models, plugins } = api
  const bizModels = models.biz
  const handleProductApplication = co(function* (req) {
    const { user, object } = req
    const product = getProductFromEnumValue({
      bizModels,
      value: object.requestFor
    })

    debug(`received application for "${product}"`)
    const isOfferedProduct = bizModels.products.includes(product)
    if (!isOfferedProduct) {
      debug(`ignoring application for "${product}" as it's not in specified offering`)
      return
    }

    if (req.application) {
      // ignore and continue existing
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
    }

    req.application = yield this.sign(this.state.createApplication(req))
    this.state.addApplication(req)
    yield this.continueApplication(req)
  })

  const handleForm = co(function* (req) {
    const { application, object, type } = req
    if (!application) {
      debug('application is unknown, ignoring form')
      return
    }

    if (type === models.biz.productRequest.id) {
      // handled by handleProductApplication
      return
    }

    if (application && application.requestFor === REMEDIATION) return

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
      yield this.requestEdit({ req, details: err })
      return
    }

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
    const { user, object } = req
    if (!object.profile) return

    const { firstName } = user
    this.state.setProfile({ user, object })
    if (user.firstName !== firstName) {
      yield this.send({
        req,
        object: createSimpleMessage(format(STRINGS.HI_JOE, user.firstName))
      })
    }
  })

  function sendApplicationSubmitted (req) {
    const { user, application } = req
    return this.send({
      req,
      object: createSimpleMessage(STRINGS.APPLICATION_SUBMITTED)
    })
  }

  const banter = co(function* (req) {
    const { object } = req
    yield this.send({
      req,
      object: createSimpleMessage(format(STRINGS.TELL_ME_MORE, object.message))
    })
  })

  function willRequestForm ({ formRequest }) {
    const model = models.all[formRequest.form]
    let message
    if (model.id === models.biz.productRequest.id) {
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

  function willSend (opts) {
    const { req, to } = opts
    if (!to) opts.to = req.user
  }

  const defaults = {
    willSend,
    didSend,
    shouldSealSent,
    shouldSealReceived,
    getRequiredForms,
    validateForm,
    willRequestForm,
    onFormsCollected: [
      setCompleted,
      sendApplicationSubmitted,
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
    'tradle.Form': handleForm,
    'tradle.Verification': handleVerification,
    [models.biz.productRequest.id]: handleProductApplication,
    'tradle.SimpleMessage': banter,
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
