const { TYPE, SIG } = require('@tradle/constants')
const {
  co,
  isPromise,
  format,
  shallowExtend,
  debug,
  validateRequired,
  getProductFromEnumValue
} = require('./utils')

const STRINGS = require('./strings')
const REMEDIATION = 'tradle.Remediation'

module.exports = function ({ models, plugins }) {
  const handleProductApplication = co(function* (data) {
    const { user, object, permalink, link, application } = data
    const product = getProductFromEnumValue({
      bizModels: models.biz,
      value: object.product
    })

    debug(`received application for "${product}"`)
    const isOfferedProduct = models.biz.products.find(model => model.id === product)
    if (!isOfferedProduct) {
      debug(`ignoring application for "${product}" as it's not in specified offering`)
      return
    }

    if (data.application) {
      // ignore and continue existing
      //
      // delegate this decision to the outside?
      yield this.continueApplication(data)
      return
    }

    const existingProduct = user.certificates.find(applicationState => {
      return applicationState.product == object.product
    })

    if (existingProduct) {
      const maybePromise = plugins.exec({
        method: 'onApplicationForExistingProduct',
        args: [data]
      })

      if (isPromise(maybePromise)) yield maybePromise
    }

    data.application = this.state.addApplication(data)
    yield this.continueApplication(data)
  })

  const handleForm = co(function* (data) {
    const { application, object } = data
    if (application && application.product === REMEDIATION) return

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
      yield this.requestEdit(shallowExtend(data, err))
      return
    }

    this.state.addForm(data)
    yield this.continueApplication(data)
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

  const handleVerification = co(function* (data) {
    this.state.importVerification(data)
    yield this.continueApplication(data)
  })

  const saveName = co(function* ({ user, object }) {
    if (!object.profile) return

    const { firstName } = user
    this.state.setProfile({ user, object })
    if (user.firstName !== firstName) {
      yield this.bot.send(user, format(STRINGS.HI_JOE, user.firstName))
    }
  })

  const banter = co(function* (data) {
    const { user, object } = data
    yield this.bot.send(user, format(STRINGS.TELL_ME_MORE, object.message))
  })

  function willRequestForm ({ formRequest }) {
    const model = models.all[formRequest.form]
    let message
    if (model.id === models.biz.application.id) {
      message = STRINGS.PRODUCT_LIST_MESSAGE
    } else if (model.subClassOf === 'tradle.Form') {
      message = STRINGS.PLEASE_FILL_FIRM
    } else {
      message = STRINGS.PLEASE_GET_THIS_PREREQUISITE_PRODUCT
    }

    formRequest.message = message
  }

  function proxyFor (method) {
    return function (...args) {
      return this[method](...args)
    }
  }

  const defaults = {
    getRequiredForms,
    validateForm,
    willRequestForm,
    onFormsCollected: proxyFor('issueCertificate')
  }

  shallowExtend(defaults, prependKeysWith('onmessage:', {
    'tradle.SelfIntroduction': [
      saveName,
      proxyFor('sendProductList')
    ],
    'tradle.IdentityPublishRequest': [
      saveName,
      proxyFor('sendProductList')
    ],
    'tradle.Form': handleForm,
    'tradle.Verification': handleVerification,
    [models.biz.application.id]: handleProductApplication,
    'tradle.SimpleMessage': banter,
    'tradle.CustomerWaiting': proxyFor('sendProductList'),
    'tradle.ForgetMe': proxyFor('forgetUser'),
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
function getRequiredForms ({ application, productModel }) {
  return productModel.forms.slice()
}