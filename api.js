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
  const productChooser = createItemRequest({
    item: appModels.application.id
  })

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

  function getNextRequiredItem ({ user, application }) {
    const productModel = modelById[application.product]
    return productModel.forms.find(form => !user.forms[form])
  }

  const requestNextRequiredItem = co(function* ({ user, application }) {
    const next = getNextRequiredItem({ user, application })
    if (!next) return false

    const { product } = application
    const context = application.permalink
    debug(`requesting next form for ${product}: ${next}`)
    const reqNextForm = createItemRequest({
      product,
      item: next
    })

    yield send(user, reqNextForm, { context })
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

  return {
    verify,
    issueProductCertificate,
    requestEdit,
    getNextRequiredItem,
    requestNextForm: requestNextRequiredItem,
    createItemRequest,
    sendProductList,
    models: modelById
    // continueApplication
  }
}
