const debug = require('debug')('tradle:bot:products:api')
const uuid = require('uuid/v4')
const buildResource = require('@tradle/build-resource')
const baseModels = require('@tradle/models/models')
const {
  co,
  // parseId
} = require('./utils')

const { addVerification } = require('./state')
const STRINGS = require('./strings')
const TYPE = '_t'
const VERIFICATION = 'tradle.Verification'

module.exports = function createAPI ({ bot, modelById, appModels }) {
  const models = Object.keys(modelById).map(id => modelById[id])

  function send (user, object) {
    return bot.send({ userId: user.id, object })
  }

  function save (user) {
    return bot.users.save(user)
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

    user.products[product].push(application)
    user.applications[product] = user.applications[product].filter(app => {
      app.permalink !== application.permalink
    })

    // if (user.currentApplication.link === application.link) {
    //   delete user.currentApplication
    // }

    const certificateModel = appModels.certificateForProduct[product]
    const certificate = {
      [TYPE]: certificateModel.id,
      myProductId: uuid()
    }

    return send(user, certificate)
  })

  const verify = co(function* ({ user, wrapper, verification={} }) {
    const { object, permalink, link } = wrapper
    if (typeof user === 'string') {
      user = yield bot.users.get(user)
    }

    const builder = buildResource({
        models,
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

    yield save(user)
  })

  const requestNextRequiredItem = co(function* ({ user, application }) {
    const { product } = application
    const productModel = modelById[product]
    const next = productModel.forms.find(form => !user.forms[form])
    if (!next) {
      return false
      // return issueProductCertificate({ user, application })
    }

    debug(`requesting next form for ${product}: ${next}`)
    const reqNextForm = createItemRequest({
      product,
      item: next
    })

    yield send(user, reqNextForm)
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

  return {
    verify,
    issueProductCertificate,
    requestNextForm: requestNextRequiredItem,
    createItemRequest,
    // continueApplication
  }
}
