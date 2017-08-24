const validateResource = require('@tradle/validate-resource')
const { parseEnumValue } = validateResource.utils
const { TYPE, SIG } = require('@tradle/constants')
const {
  co,
  isPromise,
  format,
  shallowExtend,
  shallowClone,
  debug,
  validateRequired,
  newFormState,
  normalizeUserState
} = require('./utils')

const { addVerification } = require('./state')
const createAPI = require('./api')
const createPlugins = require('./plugins')
const STRINGS = require('./strings')
const VERIFICATION = 'tradle.Verification'
const TESTING = process.env.NODE_ENV === 'test'
const STATE_PROPS = ['forms', 'applications', 'products', 'importedVerifications', 'issuedVerifications', 'imported']
const REMEDIATION = 'tradle.Remediation'

module.exports = function productsStrategyImpl (opts) {
  return bot => install(bot, opts)
}

function install (bot, opts) {
  const {
    models,
    appModels,
    validateIncoming
  } = opts

  const pluginContext = { models, appModels }
  const plugins = createPlugins()
  plugins.setContext(pluginContext)
  const execPlugins = (method, ...args) => plugins.exec({ method, args })

  const defaultPlugin = {}
  const api = (function () {
    const rawAPI = createAPI({ bot, plugins, models, appModels })
    const apiProxy = {}
    for (let key in rawAPI) {
      let val = rawAPI[key]
      if (typeof val === 'function') {
        defaultPlugin[key] = val.bind(rawAPI)
        apiProxy[key] = execPlugins.bind(null, key)
      } else {
        apiProxy[key] = val
      }
    }

    return apiProxy
  }())

  function send (user, object) {
    return bot.send({ to: user.id, object })
  }

  function ensureStateStructure (user) {
    STATE_PROPS.forEach(prop => {
      if (!user[prop]) user[prop] = {}
    })

    // user.forms = {
    //   // structure:
    //   //
    //   // 'tradle.AboutYou': {
    //   //   [form.permalink]: [link1, link2, ...]
    //   // }
    //   // 'tradle.PhotoID': {
    //   //   [form.permalink]: [link1, link2, ...]
    //   // }
    // }

    // user.applications = {
    //   // structure:
    //   //
    //   // 'tradle.CurrentAccount': [{ link, permalink }]
    // }

    // user.products = {}
    // user.importedVerifications = {}
    // user.issuedVerifications = {}
    // user.imported = {}
  }

  // const oncreate = co(function* (user) {
  //   // yield save(user)
  //   if (!TESTING) {
  //     yield send(user, STRINGS.NICE_TO_MEET_YOU)
  //   }
  // })

  const onmessage = co(function* (data) {
    // make a defensive copy
    data = shallowClone(data)
    if (!data.object && data.payload) {
      data.object = data.payload
    }

    const { user, object, type } = data

    ensureStateStructure(user)
    normalizeUserState(user)
    deduceCurrentApplication(data)

    const model = models[type]

    let maybePromise
    switch (type) {
    case 'tradle.SelfIntroduction':
      maybePromise = execPlugins('onSelfIntroduction', data)
      break
    case 'tradle.IdentityPublishRequest':
      maybePromise = execPlugins('onIdentityPublishRequest', data)
      break
    case 'tradle.SimpleMessage':
      maybePromise = execPlugins('onSimpleMessage', data)
      break
    case 'tradle.CustomerWaiting':
      maybePromise = execPlugins('onCustomerWaiting', data)
      break
    case VERIFICATION:
      maybePromise = execPlugins('onVerification', data)
      break
    case appModels.application.id:
      maybePromise = execPlugins('onApplication', data)
      break
    case 'tradle.ForgetMe':
      maybePromise = execPlugins('onForgetMe', data)
      break
    default:
      if (model && model.subClassOf === 'tradle.Form') {
        maybePromise = execPlugins('onForm', data)
        break
      }

      maybePromise = execPlugins('onUnhandledMessage', data)
      break
    }

    if (isPromise(maybePromise)) yield maybePromise
  })


  const removeReceiveHandler = bot.onmessage(onmessage)
  // const removeCreateHandler = bot.onusercreate(oncreate)

  const banter = co(function* (data) {
    const { user, object } = data
    yield send(user, format(STRINGS.TELL_ME_MORE, object.message))
  })

  function deduceCurrentApplication (data) {
    const { user, context, type } = data
    if (type === appModels.application.id) return

    const { applications, products } = user
    if (context) {
      data.currentApplication = getApplicationByPermalink(applications, context)
      data.currentProduct = getApplicationByPermalink(products, context)
      if (!(data.currentApplication || data.currentProduct)) {
        throw new Error(`application ${context} not found`)
      }

      return
    }

    data.currentApplication = guessApplicationFromIncomingType(applications, type)
    data.currentProduct = guessApplicationFromIncomingType(products, type)

    // data.currentApplication = getApplicationByType(applications)
    // data.currentProduct = getApplicationByType(products)
  }

  function guessApplicationFromIncomingType (applications, type) {
    return findApplication(applications, app => {
      const productModel = models[app.type]
      return productModel.forms.indexOf(type) !== -1
    })
  }

  function findApplication (applications, test) {
    for (let productType in applications) {
      let match = applications[productType].find(test)
      if (match) return match
    }
  }

  function getApplicationByPermalink (applications, permalink) {
    return findApplication(applications, app => app.permalink === permalink)
  }

  function getApplicationByType (applications, type) {
    return (applications[type] || [])[0]
  }

  function noComprendo ({ user, type }) {
    const model = models[type]
    const title = model ? model.title : type
    return send(user, format(STRINGS.NO_COMPRENDO, title))
  }

  const handleProductApplication = co(function* (data) {
    const { user, object, permalink, link, currentApplication, currentProduct } = data
    const product = getProductFromEnumValue(object.product)
    const isOfferedProduct = appModels.products.find(model => model.id === product)
    if (!isOfferedProduct) {
      debug(`ignoring application for "${product}" as it's not in specified offering`)
      return
    }

    if (data.currentApplication) {
      // ignore and continue existing
      //
      // delegate this decision to the outside?
      yield continueApplication(data)
      return
    }

    // if (user.products[product]) {
    //   const productModel = models[product]
    //   // toy response
    //   yield send(user, format(STRINGS.ANOTHER, productModel.title))
    // }


    if (!user.applications[product]) {
      user.applications[product] = []
    }

    // user.currentApplication = { product, permalink, link }
    data.currentApplication = {
      type: product,
      link,
      permalink,
      forms: []
    }

    user.applications[product].push(data.currentApplication)
    yield continueApplication(data)
  })

  const handleForm = co(function* (data) {
    const { user, object, type, link, permalink, currentApplication } = data
    if (currentApplication && currentApplication.type === REMEDIATION) return

    const err = execPlugins('validateForm', {
      application: currentApplication,
      form: object,
      returnResult: true
    })

    if (err) {
      yield api.requestEdit(shallowExtend(data, err))
      return
    }

    currentApplication.forms.push(newFormState(data))

    // const forms = user.forms[type]
    // let known = forms.find(form => form.permalink === permalink)
    // if (!known) {
    //   known = { permalink, versions: [] }
    //   forms.push(known)
    // }

    // known.versions.push({ link })
    yield continueApplication(data)
  })

  const continueApplication = co(function* (data) {
    if (!data.currentApplication) return

    data = shallowExtend({ application: data.currentApplication }, data)
    const requested = yield api.requestNextRequiredItem(data)
    if (!requested) {
      const maybePromise = execPlugins('onFormsCollected', data)
      if (isPromise(maybePromise)) yield maybePromise
    }
  })

  function handleVerification (data) {
    const { user, object } = data
    addVerification({
      state: user.importedVerifications,
      verification: object,
      verifiedItem: object.document
    })

    return continueApplication(data)
  }

  function getProductFromEnumValue (value) {
    return parseEnumValue({
      model: appModels.productList,
      value
    }).id
  }

  const approveProduct = api.issueProductCertificate
  function forgetUser ({ user }) {
    STATE_PROPS.forEach(prop => {
      delete user[prop]
    })

    ensureStateStructure(user)
  }

  function saveName ({ user, object }) {
    if (!object.profile) return

    const name = object.profile.firstName
    const oldName = user.profile && user.profile.firstName
    user.profile = object.profile
    if (name !== oldName) {
      return send(user, format(STRINGS.HI_JOE, name))
    }
  }

  function validateForm ({ application, form }) {
    const type = form[TYPE]
    const model = this.models[type]
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

  // promisified because it might be overridden by an async function
  function getRequiredForms ({ application, productModel }) {
    return productModel.forms.slice()
  }

  function willRequestForm ({ formRequest }) {
    const model = this.models[formRequest.form]
    let message
    if (model.id === this.appModels.application.id) {
      message = STRINGS.PRODUCT_LIST_MESSAGE
    } else if (model.subClassOf === 'tradle.Form') {
      message = STRINGS.PLEASE_FILL_FIRM
    } else {
      message = STRINGS.PLEASE_GET_THIS_PREREQUISITE_PRODUCT
    }

    formRequest.message = message
  }

  shallowExtend(defaultPlugin, {
    validateForm,
    getRequiredForms,
    willRequestForm,
    onSelfIntroduction: [
      saveName,
      api.sendProductList
    ],
    onIdentityPublishRequest: [
      saveName,
      api.sendProductList
    ],
    onForm: handleForm,
    onVerification: handleVerification,
    onApplication: handleProductApplication,
    onFormsCollected: approveProduct,
    onSimpleMessage: banter,
    onCustomerWaiting: api.sendProductList,
    onForgetMe: forgetUser,
    onUnhandledMessage: noComprendo
  })

  const removeDefaultHandlers = plugins.use(defaultPlugin)

  function removeDefaultHandler (method) {
    const handler = defaultPlugin[method]
    plugins.remove(method, handler)
    return handler
  }

  function uninstall () {
    removeReceiveHandler()
    // removeCreateHandler()
  }

  return shallowExtend({
    plugins,
    uninstall,
    removeDefaultHandler,
    removeDefaultHandlers,
    models
  }, api)
}
