const { TYPE, SIG } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const {
  co,
  isPromise,
  format,
  shallowExtend,
  debug,
  validateRequired,
  getProductFromEnumValue,
} = require('./utils')

const STRINGS = require('./strings')
const REMEDIATION = 'tradle.Remediation'

module.exports = function (api) {
  const { models, plugins } = api
  const handleProductApplication = co(function* (data) {
    const { user, object } = data
    const product = getProductFromEnumValue({
      bizModels: models.biz,
      value: object.requestFor
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

    const existingProduct = user.certificates.find(application => {
      return application.requestFor === object.requestFor
    })

    if (existingProduct) {
      const maybePromise = plugins.exec({
        method: 'onrequestForExistingProduct',
        args: [data]
      })

      if (isPromise(maybePromise)) yield maybePromise
    }

    data.application = yield this.signAndSave(this.state.createApplication(data))
    this.state.addApplication(data)
    yield this.continueApplication(data)
  })

  const handleForm = co(function* (data) {
    const { application, object, type } = data
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

  function saveIdentity ({ user, object }) {
    this.state.setIdentity({ user, identity: object.identity })
  }

  const saveName = co(function* ({ user, object }) {
    if (!object.profile) return

    const { firstName } = user
    this.state.setProfile({ user, object })
    if (user.firstName !== firstName) {
      yield this.send(user, format(STRINGS.HI_JOE, user.firstName))
    }
  })

  const banter = co(function* (data) {
    const { user, object } = data
    yield this.bot.send(user, format(STRINGS.TELL_ME_MORE, object.message))
  })

  function willRequestForm ({ formRequest }) {
    const model = models.all[formRequest.form]
    let message
    if (model.id === models.biz.productRequest.id) {
      message = STRINGS.PRODUCT_LIST_MESSAGE
    } else if (model.subClassOf === 'tradle.Form') {
      message = STRINGS.PLEASE_FILL_FIRM
    } else {
      message = STRINGS.PLEASE_GET_THIS_PREREQUISITE_PRODUCT
    }

    formRequest.message = message
  }

  function setCompleted ({ application }) {
    this.state.setApplicationStatus({ application, status: 'completed' })
  }

  const defaults = {
    getRequiredForms,
    validateForm,
    willRequestForm,
    onFormsCollected: [
      setCompleted,
      api.issueCertificate
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
function getRequiredForms ({ application, productModel }) {
  return productModel.forms.slice()
}
