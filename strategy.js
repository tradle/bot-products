const debug = require('debug')('tradle:bot:products')
const {
  co,
  format,
  shallowExtend,
  shallowClone
  // parseId
} = require('./utils')

const { addVerification } = require('./state')
const createAPI = require('./api')
const STRINGS = require('./strings')
const TYPE = '_t'
const VERIFICATION = 'tradle.Verification'
const TESTING = process.env.NODE_ENV === 'test'
const resolved = Promise.resolve()
const promiseNoop = () => resolved
const STATE_PROPS = ['forms', 'applications', 'products', 'importedVerifications', 'issuedVerifications', 'imported']
const REMEDIATION = 'tradle.Remediation'

module.exports = function productsStrategyImpl (bot, opts) {
  const {
    modelById,
    appModels,
    handlers
  } = opts

  const api = createAPI({ bot, modelById, appModels })
  const productChooser = api.createItemRequest({
    item: appModels.application.id
  })

  function send (user, object) {
    return bot.send({ userId: user.id, object })
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
    data = shallowClone(data)
    const { user, object, type, link, permalink } = data

    ensureStateStructure(user)
    deduceCurrentApplication(data)

    const model = modelById[type]

    switch (type) {
    case 'tradle.SelfIntroduction':
    case 'tradle.IdentityPublishRequest':
      if (!object.profile) break

      let name = object.profile.firstName
      let oldName = user.profile && user.profile.firstName
      user.profile = object.profile
      if (name !== oldName) {
        yield send(user, format(STRINGS.HOT_NAME, name))
      }

      yield send(user, productChooser)
      break
    case 'tradle.SimpleMessage':
      yield onSimpleMessage(data)
      break
    case 'tradle.CustomerWaiting':
      // if (user.history.length) {
      //   yield send(user, STRINGS.IM_HERE_IF_YOU_NEED)
      // } else {
      yield send(user, productChooser)
      // }

      break
    case VERIFICATION:
      yield handleVerification(data)
      break
    // case 'tradle.ProductApplication':
    //   if (object.product === REMEDIATION) {
    //     yield handleRemediation(data)
    //   } else {
    //     debug(`ignoring application for "${object.product}", don't know how to handle`)
    //   }

    //   break
    case appModels.application.id:
      yield handleProductApplication(data)
      break
    case 'tradle.ForgetMe':
      yield send(user, STRINGS.SORRY_TO_FORGET_YOU)

      STATE_PROPS.forEach(prop => {
        delete user[prop]
      })

      ensureStateStructure(user)
      yield send(user, { [TYPE]: 'tradle.ForgotYou' })
      break
    default:
      if (model && model.subClassOf === 'tradle.Form') {
        yield handleForm(data)
        break
      }

      let title = model ? model.title : type
      yield send(user, format(STRINGS.NO_COMPRENDO, title))
      break
    }
  })

  const removeReceiveHandler = bot.addReceiveHandler(onmessage)
  bot.users.on('create', oncreate)

  const handleSimpleMessage = co(function* (data) {
    yield onSimpleMessage(data)
  })

  const banter = co(function* (data) {
    const { user, object } = data
    send(user, format(STRINGS.TELL_ME_MORE, object.message))
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
    } else {
      data.currentApplication = guessApplicationFromIncomingType(applications, type)
      data.currentProduct = guessApplicationFromIncomingType(products, type)
    }

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
      return continueApplication(data)
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
    yield onApplication(data)
  })

  const handleForm = co(function* handleForm (data) {
    const { user, object, type, link, permalink, currentApplication } = data
    if (currentApplication && currentApplication.type === REMEDIATION) return

    if (!user.forms[type]) {
      user.forms[type] = {}
    }

    const forms = user.forms[type]
    if (!forms[permalink]) {
      forms[permalink] = []
    }

    forms[permalink].push(link)
    yield onForm(data)
  })

  const continueApplication = co(function* (data) {
    if (!data.currentApplication) return

    data = shallowExtend({ application: data.currentApplication }, data)
    const requested = yield api.requestNextForm(data)
    if (!requested) yield onFormsCollected(data)
  })

  const handleVerification = co(function* (data) {
    const { user, object } = data
    addVerification({
      state: user.importedVerifications,
      verification: object,
      verifiedItem: object.document
    })

    yield onVerification(data)
  })

  function getProductFromEnumValue (value) {
    if (value.indexOf(appModels.productList.id) === 0) {
      return value.slice(appModels.productList.id.length + 1)
    }

    return value
  }

  function uninstall () {
    removeReceiveHandler()
    bot.users.removeListener('create', oncreate)
  }

  const approveProduct = api.issueProductCertificate

  const {
    onForm=continueApplication,
    onVerification=continueApplication,
    onApplication=continueApplication,
    onFormsCollected=approveProduct,
    onSimpleMessage=banter
  } = handlers

  return shallowExtend({
    uninstall,
  }, api)
}
