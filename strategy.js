const debug = require('debug')('tradle:bot:products')
const uuid = require('uuid/v4')
const {
  co,
  format,
  // parseId
} = require('./utils')

const STRINGS = require('./strings')
const TYPE = '_t'
const TESTING = process.env.NODE_ENV === 'test'

module.exports = function productsStrategyImpl (bot, opts) {
  const {
    modelById,
    appModels
  } = opts

  const productChooser = createItemRequest({
    item: appModels.application.id
  })

  function send (user, object) {
    return bot.send({ userId: user.id, object })
  }

  function save (user) {
    return bot.users.save(user)
  }

  const oncreate = co(function* (user) {
    user.forms = {}
    user.applications = {}
    user.products = {}
    user.importedVerifications = []

    yield save(user)
    if (!TESTING) {
      yield send(user, STRINGS.NICE_TO_MEET_YOU)
    }
  })

  const onmessage = co(function* (data) {
    const { user, object } = data
    const type = object[TYPE]
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
    case 'tradle.Verification':
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

  const handleSimpleMessage = co(function* handleSimpleMessage (data) {
    const { user, object } = data
    send(user, format(STRINGS.TELL_ME_MORE, object.message))
  })

  const handleProductApplication = co(function* handleProductApplication (data) {
    const { user, object } = data
    const product = getProductFromEnumValue(object.product.id)
    if (user.products[product]) {
      const productModel = modelById[product]
      // toy response
      yield send(user, format(STRINGS.ANOTHER, productModel.title))
    }

    if (!user.applications[product]) {
      user.applications[product] = object
    }

    user.currentApplication = product
    return requestNextRequiredItem(data)
  })

  const handleForm = co(function* handleForm (data) {
    const { user, object } = data
    user.forms[object[TYPE]] = object
    return requestNextRequiredItem(data)
  })

  const requestNextRequiredItem = co(function* requestNextRequiredItem ({ user }) {
    const product = user.currentApplication
    const productModel = modelById[product]
    const next = productModel.forms.find(form => !user.forms[form])
    if (!next) {
      // we're done!
      if (user.products[product]) {
        user.products[product]++
      } else {
        user.products[product] = 1
      }

      const certificateModel = appModels.certificateForProduct[product]
      const certificate = {
        [TYPE]: certificateModel.id,
        myProductId: uuid()
      }

      return send(user, certificate)
      // return send(user, format(STRINGS.GOT_PRODUCT, productModel.title))
    }

    debug(`requesting next form for ${product}: ${next}`)
    const reqNextForm = createItemRequest({
      product,
      item: next
    })

    return send(user, reqNextForm)
  })

  const handleVerification = co(function* ({ user, object }) {
    user.importedVerifications.push(object)
  })

  /**
   * Request the next required item from productModel.forms
   * @param  {product} options.product [description]
   * @param  {[type]} options.item    [description]
   * @return {[type]}                 [description]
   */
  function createItemRequest ({ product, item }) {
    const model = modelById[item]
    let message
    if (model.id === appModels.application.id) {
      message = STRINGS.PRODUCT_LIST_MESSAGE
    } else if (model.subClassOf === 'tradle.Form') {
      message = STRINGS.PLEASE_FILL_FIRM
    } else {
      message = STRINGS.PLEASE_GET_THIS_PREREQUISITE_PRODUCT
    }

    const req = {
      [TYPE]: 'tradle.FormRequest',
      form: item,
      message
    }

    if (product) req.product = product

    return req
  }

  function getProductFromEnumValue (value) {
    if (value.indexOf(appModels.productList.id) === 0) {
      return value.slice(appModels.productList.id.length + 1)
    }

    return value
  }

  return function disable () {
    removeReceiveHandler()
    bot.users.removeListener('create', oncreate)
  }
}
