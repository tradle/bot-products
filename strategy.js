const debug = require('debug')('tradle:bot:products')
const {
  co,
  format,
  shallowExtend
  // parseId
} = require('./utils')

const { addVerification } = require('./state')
const createAPI = require('./api')
const STRINGS = require('./strings')
const TYPE = '_t'
const VERIFICATION = 'tradle.Verification'
const TESTING = process.env.NODE_ENV === 'test'

module.exports = function productsStrategyImpl (bot, opts) {
  const {
    modelById,
    appModels
  } = opts

  const api = createAPI({ bot, modelById, appModels })
  const productChooser = api.createItemRequest({
    item: appModels.application.id
  })

  function send (user, object) {
    return bot.send({ userId: user.id, object })
  }

  function save (user) {
    return bot.users.save(user)
  }

  const oncreate = co(function* (user) {
    // objects by permalink
    user.objects = {
      // structure:
      //
      // [permalink]: { type, link, object }
    }

    user.forms = {
      // structure:
      //
      // 'tradle.AboutYou': {
      //   [form.permalink]: [link1, link2, ...]
      // }
      // 'tradle.PhotoID': {
      //   [form.permalink]: [link1, link2, ...]
      // }
    }

    user.applications = {
      // structure:
      //
      // 'tradle.CurrentAccount': [{ link, permalink }]
    }

    user.products = {}
    user.importedVerifications = {}
    user.issuedVerifications = {}

    yield save(user)
    if (!TESTING) {
      yield send(user, STRINGS.NICE_TO_MEET_YOU)
    }
  })

  const onmessage = co(function* (data) {
    const { user, object, type, link, permalink } = data
    if (!user.objects[permalink]) {
      user.objects[permalink] = []
    }

    user.objects[permalink].push({ type, object, link })

    const model = modelById[type]

    switch (type) {
    case 'tradle.SelfIntroduction':
    case 'tradle.IdentityPublishRequest':
      if (!object.profile) break

      let name = object.profile.firstName
      let oldName = user.profile && user.profile.firstName
      user.profile = object.profile
      yield save(user)
      if (name !== oldName) {
        yield send(user, format(STRINGS.HOT_NAME, name))
      }

      yield send(user, productChooser)
      break
    case 'tradle.SimpleMessage':
      yield handleSimpleMessage(data)
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
    case appModels.application.id:
      yield handleProductApplication(data)
      break
    case 'tradle.ForgetMe':
      yield send(user, STRINGS.SORRY_TO_FORGET_YOU)

      ;['forms', 'applications', 'products', 'importedVerifications', 'history'].forEach(prop => {
        const val = user[prop]
        if (Array.isArray(val)) {
          val.length = 0
        } else {
          user[prop] = {}
        }
      })

      yield save(user)
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
    const { user, object } = data
    send(user, format(STRINGS.TELL_ME_MORE, object.message))
  })

  const handleProductApplication = co(function* (data) {
    const { user, object, permalink, link } = data
    const product = getProductFromEnumValue(object.product.id)
    if (user.products[product]) {
      const productModel = modelById[product]
      // toy response
      yield send(user, format(STRINGS.ANOTHER, productModel.title))
    }

    if (!user.applications[product]) {
      user.applications[product] = []
    }

    user.currentApplication = { product, permalink, link }
    user.applications[product].push({ permalink, link })
    return continueApplication(data)
  })

  const handleForm = co(function* handleForm (data) {
    const { user, object, type, link, permalink } = data
    if (!user.forms[type]) {
      user.forms[type] = {}
    }

    const forms = user.forms[type]
    if (!forms[permalink]) {
      forms[permalink] = []
    }

    forms[permalink].push(link)
    return continueApplication(data)
  })

  const continueApplication = co(function* (data) {
    const { user } = data
    data = shallowExtend({ application: user.currentApplication }, data)
    const requested = yield api.requestNextForm(data)
    if (!requested) return api.issueProductCertificate(data)
  })

  const handleVerification = co(function* ({ user, object }) {
    addVerification({
      state: user.importedVerifications,
      verification: object,
      verifiedItem: object.document
    })
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

  return shallowExtend({
    uninstall,
  }, api)
}
