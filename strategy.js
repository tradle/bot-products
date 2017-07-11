const debug = require('debug')('tradle:bot:products')
const {
  co,
  isPromise,
  format,
  shallowExtend,
  shallowClone
} = require('./utils')

const { addVerification } = require('./state')
const createAPI = require('./api')
const createPlugins = require('./plugins')
const STRINGS = require('./strings')
const TYPE = '_t'
const VERIFICATION = 'tradle.Verification'
const TESTING = process.env.NODE_ENV === 'test'
const STATE_PROPS = ['forms', 'applications', 'products', 'importedVerifications', 'issuedVerifications', 'imported']
const REMEDIATION = 'tradle.Remediation'

module.exports = function productsStrategyImpl (opts) {
  return bot => install(bot, opts)
}

function install (bot, opts) {
  const {
    modelById,
    appModels
  } = opts

  const api = createAPI({ bot, modelById, appModels })
  const plugins = createPlugins()

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

  const oncreate = co(function* (user) {
    // yield save(user)
    if (!TESTING) {
      yield send(user, STRINGS.NICE_TO_MEET_YOU)
    }
  })

  const onmessage = co(function* (data) {
    // make a defensive copy
    const { wrapper } = data
    data = shallowClone(data, wrapper.payload)

    const { user, object, type } = data

    ensureStateStructure(user)
    deduceCurrentApplication(data)

    const model = modelById[type]

    switch (type) {
    case 'tradle.SelfIntroduction':
      yield plugins.exec('onSelfIntroduction', data)
      break
    case 'tradle.IdentityPublishRequest':
      yield plugins.exec('onIdentityPublishRequest', data)
      break
    case 'tradle.SimpleMessage':
      yield plugins.exec('onSimpleMessage', data)
      break
    case 'tradle.CustomerWaiting':
      yield plugins.exec('onCustomerWaiting', data)
      break
    case VERIFICATION:
      yield plugins.exec('onVerification', data)
      break
    // case 'tradle.ProductApplication':
    //   if (object.product === REMEDIATION) {
    //     yield handleRemediation(data)
    //   } else {
    //     debug(`ignoring application for "${object.product}", don't know how to handle`)
    //   }

    //   break
    case appModels.application.id:
      yield plugins.exec('onApplication', data)
      break
    case 'tradle.ForgetMe':
      yield plugins.exec('onForgetMe', data)
      break
    default:
      if (model && model.subClassOf === 'tradle.Form') {
        yield plugins.exec('onForm', data)
        break
      }

      yield plugins.exec('onUnknownMessage', data)
      break
    }
  })

  const removeReceiveHandler = bot.onmessage(onmessage)
  const removeCreateHandler = bot.onusercreate(oncreate)

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
      const productModel = modelById[app.product]
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
    const model = modelById[type]
    const title = model ? model.title : type
    return send(user, format(STRINGS.NO_COMPRENDO, title))
  }

  const handleProductApplication = co(function* (data) {
    const { user, object, permalink, link, currentApplication, currentProduct } = data
    const product = getProductFromEnumValue(object.product.id)
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
    //   const productModel = modelById[product]
    //   // toy response
    //   yield send(user, format(STRINGS.ANOTHER, productModel.title))
    // }


    if (!user.applications[product]) {
      user.applications[product] = []
    }

    // user.currentApplication = { product, permalink, link }
    data.currentApplication = { product, permalink, link }
    user.applications[product].push({ product, permalink, link })
    yield continueApplication(data)
  })

  const handleForm = co(function* (data) {
    const { user, object, type, link, permalink, currentApplication } = data
    if (currentApplication && currentApplication.type === REMEDIATION) return

    if (!user.forms[type]) {
      user.forms[type] = []
    }

    const forms = user.forms[type]
    let known = forms.find(form => form.permalink === permalink)
    if (!known) {
      known = { permalink, versions: [] }
      forms.push(known)
    }

    known.versions.push({ link })
    yield continueApplication(data)
  })

  const continueApplication = co(function* (data) {
    if (!data.currentApplication) return

    data = shallowExtend({ application: data.currentApplication }, data)
    const requested = yield api.requestNextForm(data)
    if (!requested) yield plugins.exec('onFormsCollected', data)
  })

  const handleVerification = co(function* (data) {
    const { user, object } = data
    addVerification({
      state: user.importedVerifications,
      verification: object,
      verifiedItem: object.document
    })

    yield continueApplication(data)
  })

  function getProductFromEnumValue (value) {
    if (value.indexOf(appModels.productList.id) === 0) {
      return value.slice(appModels.productList.id.length + 1)
    }

    return value
  }

  const approveProduct = api.issueProductCertificate
  const forgetUser = co(function* ({ user }) {
    STATE_PROPS.forEach(prop => {
      delete user[prop]
    })

    ensureStateStructure(user)
  })

  const saveProfile = co(function* ({ user, object }) {
    if (!object.profile) return

    const name = object.profile.firstName
    const oldName = user.profile && user.profile.firstName
    user.profile = object.profile
    if (name !== oldName) {
      yield send(user, format(STRINGS.HOT_NAME, name))
    }

    yield api.sendProductList(data)
  })

  const defaults = {
    onSelfIntroduction: saveProfile,
    onIdentityPublishRequest: saveProfile,
    onForm: handleForm,
    onVerification: handleVerification,
    onApplication: handleProductApplication,
    onFormsCollected: approveProduct,
    onSimpleMessage: banter,
    onCustomerWaiting: api.sendProductList,
    onForgetMe: forgetUser,
    onUnknownMessage: noComprendo,
    getRequiredItems: api.getRequiredItems
  }

  const removeDefaultHandlers = plugins.use(defaults)

  function removeDefaultHandler (method) {
    return plugins.remove(method, defaults[method])
  }

  function uninstall () {
    removeReceiveHandler()
    removeCreateHandler()
  }

  return shallowExtend({
    uninstall,
    use: plugins.use,
    removeDefaultHandler,
    removeDefaultHandlers
  }, api)
}
