const uuid = require('uuid/v4')
const omit = require('object.omit')
const buildResource = require('@tradle/build-resource')
const baseModels = require('./base-models')
const {
  co,
  debug,
  isPromise
  // parseId
} = require('./utils')

const { addVerification } = require('./state')
const STRINGS = require('./strings')
const TYPE = '_t'
const VERIFICATION = 'tradle.Verification'

module.exports = function createAPI ({ bot, plugins, models, appModels }) {
  let productChooser

  function send (user, object, other) {
    return bot.send({ to: user.id, object, other })
  }

  const issueProductCertificate = co(function* ({ user, application }) {
    if (!application.type) {
      application = user.applications.find(app => app.permalink === application.permalink)
    }

    const product = application.type

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
      models: models,
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
  const getNextRequiredItem = co(function* ({ application }) {
    const productModel = models[application.type]
    const required = yield plugins.exec({
      method: 'getRequiredForms',
      args: [{ application, productModel }],
      returnResult: true
    })

    return required.find(form => {
      return application.forms.every(({ type }) => type !== form)
    })
  })

  const requestNextRequiredItem = co(function* ({ user, application }) {
    const next = yield api.getNextRequiredItem({ user, application })
    if (!next) return false

    yield requestItem({ user, application, item: next })
    return true
  })

  // promisified because it might be overridden by an async function
  const requestItem = co(function* ({ user, application, item }) {
    const product = application.type
    const context = application.permalink
    debug(`requesting next form for ${product}: ${item}`)
    const reqItem = yield api.createItemRequest({ user, application, product, item })
    yield send(user, reqItem, { context })
    return true
  })

  // promisified because it might be overridden by an async function
  const createItemRequest = co(function* ({ user, application, product, item }) {
    const req = {
      [TYPE]: 'tradle.FormRequest',
      form: item
    }

    if (!product && application) product = application.type
    if (product) req.product = product

    const ret = plugins.exec('willRequestForm', {
      application,
      form: item,
      formRequest: req,
      user,
      // compat with tradle/tim-bank
      state: user
    })

    if (isPromise(ret)) yield ret

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
    models,
    appModels,
    verify,
    issueProductCertificate,
    requestEdit,
    getNextRequiredItem,
    requestNextRequiredItem,
    createItemRequest,
    sendProductList
    // continueApplication
  }

  return api
}
