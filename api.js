const omit = require('object.omit')
const { TYPE } = require('@tradle/constants')
const createStateMutater = require('./state')
const {
  co,
  debug,
  isPromise
  // parseId
} = require('./utils')

module.exports = function createAPI ({ bot, plugins, models, appModels, privateModels }) {
  let productChooser

  const State = createStateMutater({
    models,
    appModels,
    privateModels
  })

  function send (user, object, other) {
    return bot.send({ to: user.id, object, other })
  }

  function getContext (application) {
    return application.permalink
  }

  const issueProductCertificate = co(function* ({ user, application }) {
    State.addCertificate({ user, application })
    return send(user, application.certificate, getContext(application))
  })

  const revokeProductCertificate = co(function* ({ user, appState, certificate }) {
    if (!appState) {
      appState = user.products.find(app => {
        return app.certificate._link === certificate._link
      })
    }

    State.revokeCertificate({ user, appState })
    return send(user, appState.certificate)
  })

  const verify = co(function* ({ user, object, verification={} }) {
    if (typeof user === 'string') {
      user = yield bot.users.get(user)
    }

    verification = State.createVerification({ user, object, verification })
    verification = yield send(user, verification)
    State.addVerification({ user, object, verification })
    return verification
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

  const requestNextRequiredItem = co(function* ({ user, appState }) {
    const next = yield api.getNextRequiredItem({ user, appState })
    if (!next) return false

    yield requestItem({ user, appState, item: next })
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
    yield send(user, {
      _t: 'tradle.FormError',
      prefill: omit(object, '_s'),
      message,
      errors
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
