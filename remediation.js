const { parseStub } = require('@tradle/validate-resource').utils
const {
  REMEDIATION,
  PRODUCT_APPLICATION,
  FORM,
  VERIFIED_ITEM,
  MY_PRODUCT
} = require('./types')

const {
  Promise,
  co
} = require('./utils')

module.exports = function remediationHandler ({ bot, api, appModels, db }) {
  db = Promise.promisifyAll(db)

  const importSession = co(function* (data) {
    const { type, object, link, permalink } = data
    if (type !== REMEDIATION) return

    const sessionId = object.session
    const session = yield db.getAsync(sessionId)
    if (!user.imported[sessionId]) {
      const permalink = req.payload.permalink
      user.imported[sessionId] = permalink
      user.imported[permalink] = {
        length: session.length,
        items: session,
        imported: []
      }

      const application = { product: type, permalink, link }
      if (!user.applications[type]) {
        user.applications[type] = []
      }

      user.applications[type].push(application)
    }

    const application = user.applications.find(app => app.permalink === permalink)
    // data.context = user.imported[sessionId]
    // return api.requestNextForm({ user, application })

    const { imported, items, length } = user.imported[permalink]
    const isRemediationReq = type === PRODUCT_APPLICATION && object.product === REMEDIATION
    if (isRemediationReq || items.length === length) {
      const forms = imported.concat(items).map(item => {
        const type = item[TYPE]
        const model = this.models[type]
        if (model) {
          if (model.subClassOf === FORM) return item
          if (model.id === VERIFIED_ITEM) return item.item
        }
      })
      .filter(item => item) // filter out nulls

      // TODO: separate out photos into "attachments" to avoid sending twice
      const req = {
        [TYPE]: CONFIRM_PACKAGE_REQUEST,
        message: 'Importing...please review your data',
        items: forms
      }

      yield bot.send({
        to: user.id,
        object: req
      })

      return
    }

    if (!items.length) {
      if (session.done) return

      session.done = true
      this._debug('finished remediation')
      const msg = this._newProductConfirmation(state, application)
      return this.send({ req, msg })
    }

    const next = items[0]
    const type = next[TYPE]
    const model = this.models[type]
    if (model && model.subClassOf === MY_PRODUCT) {
      const productType = appModels.productForCertificate[type]
      // const productType = type.replace('.My', '.') // hack
      const pModel = this.models[productType]
      const reqdForms = utils.getRequiredForms(pModel)
      const forms = application.forms.filter(stub => {
        const { type } = parseStub(stub)
        return reqdForms.indexOf(type) !== -1
      })

      const fakeApp = newApplicationState(productType, application.permalink)
      fakeApp.forms = forms
      state.pendingApplications.push(fakeApp)
      yield api.approveProduct({ req, application: fakeApp, product: next })
      items.shift()
      return this.continueProductApplication(opts)
    }
  })

  const handleForm = co(function* (data) {
    const { user, type, object, link, permalink } = data
    const { currentApplication } = user
    if (currentApplication.type !== REMEDIATION) return
  })

  return {
    importSession,
    handleForm
  }
}
