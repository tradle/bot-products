const uuid = require('uuid/v4')
const omit = require('object.omit')
const buildResource = require('@tradle/build-resource')
const baseModels = require('./base-models')
const {
  co,
  debug
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
    if (typeof user === 'string') {
      user = yield bot.users.get(user)
    }

    const builder = buildResource({
      models: modelById,
      model: baseModels[VERIFICATION],
      resource: verification
    })
    .set('document', item)

    if (!verification.dateVerified) {
      builder.set('dateVerified', Date.now())
    }

    if (!verification.sources) {
      const sources = user.importedVerifications[item._permalink]
      if (sources) {
        builder.set('sources', sources.map(source => source.verification))
      }
    }

    const result = builder.toJSON()

    yield send(user, result)
    addVerification({
      state: user.issuedVerifications,
      verification: result,
      verifiedItem: item
    })
  })

  // promisified because it might be overridden by an async function
  const getRequiredItems = co(function* ({ user, application }) {
    return modelById[application.product].forms.slice()
  })

  // promisified because it might be overridden by an async function
  const getNextRequiredItem = co(function* ({ user, application }) {
    const required = yield api.getRequiredItems({ user, application })
    return required.find(form => !user.forms[form])
  })

  const requestNextRequiredItem = co(function* ({ user, application }) {
    const next = yield api.getNextRequiredItem({ user, application })
    if (!next) return false

    yield requestItem({ user, application, item: next })
    return true
  })

  // promisified because it might be overridden by an async function
  const requestItem = co(function* ({ user, application, item }) {
    const { product } = application
    const context = application.permalink
    debug(`requesting next form for ${product}: ${item}`)
    const reqItem = yield api.createItemRequest({ product, item })
    yield send(user, reqItem, { context })
    return true
  })

  // promisified because it might be overridden by an async function
  const createItemRequest = co(function* ({ product, item }) {
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
  })

  const sendProductList = co(function* ({ user }) {
    if (!productChooser) {
      productChooser = yield api.createItemRequest({
        item: appModels.application.id
      })
    }

    return send(user, productChooser)
  })

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
    requestNextRequiredItem,
    getRequiredItems,
    createItemRequest,
    sendProductList
    // continueApplication
  }

  return api
}
