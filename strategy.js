const validateResource = require('@tradle/validate-resource')
const { parseEnumValue } = validateResource.utils
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
  newFormState,
  normalizeUserState,
  getProductFromEnumValue
} = require('./utils')

const createStateMutater = require('./state')
const createAPI = require('./api')
const createPlugins = require('./plugins')
const createPrivateModels = require('./private-models')
const STRINGS = require('./strings')
const VERIFICATION = 'tradle.Verification'
const TESTING = process.env.NODE_ENV === 'test'
const REMEDIATION = 'tradle.Remediation'

module.exports = function productsStrategyImpl (opts) {
  return bot => install(bot, opts)
}

function install (bot, opts) {
  const {
    namespace,
    models,
    appModels,
    validateIncoming
  } = opts

  const privateModels = createPrivateModels(namespace)
  shallowExtend(models, privateModels.all)

  const STATE_PROPS = Object.keys(privateModels.customer.properties)
  const State = createStateMutater({
    models,
    appModels,
    privateModels
  })

  const pluginContext = { models, appModels }
  const plugins = createPlugins()
  plugins.setContext(pluginContext)
  const execPlugins = (method, ...args) => plugins.exec({ method, args })

  const defaultPlugin = {}
  const api = (function () {
    const rawAPI = createAPI({ bot, plugins, models, appModels, privateModels })
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

    data.models = models
    data.privateModels = privateModels
    const { user, object, type } = data
    State.init(user)
    deduceCurrentApplication(data)

    const model = models[type]
    const args = [data]
    yield plugins.exec({ method: 'onmessage', args })
    yield plugins.exec({ method: `onmessage:${type}`, args })
    if (model.subClassOf) {
      yield plugins.exec({ method: `onmessage:${model.subClassOf}`, args })
    }

    if (isPromise(maybePromise)) yield maybePromise
  })


  const removeReceiveHandler = bot.onmessage(onmessage)

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
      const productModel = models[app.product]
      return productModel.forms.indexOf(type) !== -1
    })
  }

  function findApplication (applications, test) {
    for (let productType in applications) {
      let match = applications.find(test)
      if (match) return match
    }
  }

  function getApplicationByPermalink (applications, permalink) {
    return findApplication(applications, appState => {
      return appState.application.permalink === permalink
    })
  }

  function getApplicationByType (applications, type) {
    return applications.filter(appState => appState.product === type)
  }

  function noComprendo ({ user, type }) {
    const model = models[type]
    const title = model ? model.title : type
    return send(user, format(STRINGS.NO_COMPRENDO, title))
  }

  const handleProductApplication = co(function* (data) {
    const { user, object, permalink, link, currentApplication, currentProduct } = data
    const product = getProductFromEnumValue({
      appModels,
      value: object.product
    })

    debug(`received application for "${product}"`)
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

    const existingProduct = user.products.find(applicationState => {
      return applicationState.product == object.product
    })

    if (existingProduct) {
      yield plugins.exec('onApplicationForExistingProduct', data)
    }

    data.currentApplication = State.addApplication(data)
    yield continueApplication(data)
  })

  const handleForm = co(function* (data) {
    const { currentApplication, object } = data
    if (currentApplication && currentApplication.product === REMEDIATION) return

    const err = execPlugins('validateForm', {
      application: currentApplication,
      form: object,
      returnResult: true
    })

    if (err) {
      yield api.requestEdit(shallowExtend(data, err))
      return
    }

    State.addForm(data)
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

  const handleVerification = co(function* (data) {
    State.importVerification(data)
    yield continueApplication(data)
  })

  const approveProduct = ({ user, currentApplication }) => {
    return api.issueProductCertificate({ user, application: currentApplication })
  }

  const forgetUser = function ({ user }) {
    STATE_PROPS.forEach(prop => {
      delete user[prop]
    })

    State.init(user)
  }

  const saveName = co(function* ({ user, object }) {
    if (!object.profile) return

    const { firstName } = user
    State.setProfile({ user, object })
    if (user.firstName !== firstName) {
      yield send(user, format(STRINGS.HI_JOE, user.firstName))
    }
  })

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

  shallowExtend(defaultPlugin,
    {
      validateForm,
      getRequiredForms,
      willRequestForm,
    },
    prependKeysWith('onmessage:', {
      'tradle.SelfIntroduction': [
        saveName,
        api.sendProductList
      ],
      'tradle.IdentityPublishRequest': [
        saveName,
        api.sendProductList
      ],
      'tradle.Form': handleForm,
      'tradle.Verification': handleVerification,
      [appModels.application.id]: handleProductApplication,
      'tradle.SimpleMessage': banter,
      'tradle.CustomerWaiting': api.sendProductList,
      'tradle.ForgetMe': forgetUser,
      // onUnhandledMessage: noComprendo
    })
  )

  defaultPlugin['onFormsCollected'] = approveProduct

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
    state: State,
    plugins,
    uninstall,
    removeDefaultHandler,
    removeDefaultHandlers,
    models,
    appModels,
    privateModels
  }, api)
}

function prependKeysWith (prefix, obj) {
  const copy = {}
  for (let key in obj) {
    copy[prefix + key] = obj[key]
  }

  return copy
}
