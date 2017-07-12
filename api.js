const debug = require('debug')('tradle:bot:products:api')
const uuid = require('uuid/v4')
const omit = require('object.omit')
const buildResource = require('@tradle/build-resource')
const baseModels = require('./base-models')
const {
  co,
  // parseId
} = require('./utils')

const { addVerification } = require('./state')
const STRINGS = require('./strings')
const TYPE = '_t'
const VERIFICATION = 'tradle.Verification'

module.exports = function createAPI ({ bot, modelById, appModels }) {
  let productChooser

  function send (user, object, other) {
    return bot.send({ to: user.id, object, other })
  }

  const issueProductCertificate = co(function* ({ user, application }) {
    if (!application.product) {
      application = user.applications.find(app => app.permalink === application.permalink)
    }

    const { product } = application

    // we're done!
    if (!user.products[product]) {
      user.products[product] = []
    }

    // if (user.currentApplication.link === application.link) {
    //   delete user.currentApplication
    // }

    const certificateModel = appModels.certificateForProduct[product]
    const certificate = application.certificate = {
      [TYPE]: certificateModel.id,
      myProductId: uuid()
    }

    user.products[product].push(application)
    user.applications[product] = user.applications[product].filter(app => {
      app.permalink !== application.permalink
    })

    return send(user, certificate)
  })

  const verify = co(function* ({ user, item, verification={} }) {
    const { object, permalink, link } = item
    if (typeof user === 'string') {
      user = yield bot.users.get(user)
    }

    const builder = buildResource({
        models: modelById,
        model: baseModels[VERIFICATION],
        resource: verification
      })
      .document(object)

    if (!verification.dateVerified) builder.dateVerified(Date.now())
    if (!verification.sources) {
      const sources = user.importedVerifications[permalink]
      if (sources) {
        builder.sources(sources.map(source => source.verification))
      }
    }

    const result = builder.toJSON()

    yield send(user, result)
    addVerification({
      state: user.issuedVerifications,
      verification: result,
      verifiedItem: { object, link, permalink }
    })
  })

  function getRequiredItems ({ user, application }) {
    return modelById[application.product].forms.slice()
  }

  function getNextRequiredItem ({ user, application }) {
    return api.getRequiredItems({ user, application })
      .find(form => !user.forms[form])
  }

  const requestNextRequiredItem = co(function* ({ user, application }) {
    const next = api.getNextRequiredItem({ user, application })
    if (!next) return false

    yield requestItem({ user, application, item: next })
    return true
  })

  const requestItem = co(function* ({ user, application, item }) {
    const { product } = application
    const context = application.permalink
    debug(`requesting next form for ${product}: ${item}`)
    const reqItem = api.createItemRequest({ product, item })
    yield send(user, reqItem, { context })
    return true
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

  function sendProductList ({ user }) {
    if (!productChooser) {
      productChooser = api.createItemRequest({
        item: appModels.application.id
      })
    }

    return send(user, productChooser)
  }

  const requestEdit = co(function* ({ user, object, message, errors=[] }) {
    if (!message && errors.length) {
      message = errors[0].error
    }

    debug(`requesting edit for form ${object[TYPE]}`)
    yield bot.send({
      to: user.id,
      object: {
        _t: 'tradle.FormError',
        prefill: omit(object, '_s'),
        message,
        errors
      }
    })
  })

  const api = {
    verify,
    issueProductCertificate,
    requestEdit,
    getNextRequiredItem,
    requestNextForm: requestNextRequiredItem,
    getRequiredItems,
    createItemRequest,
    sendProductList
    // continueApplication
  }

  return api
}
