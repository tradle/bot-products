const co = require('co').wrap
const uuid = require('uuid/v4')
const { TYPE } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const validateResource = require('@tradle/validate-resource')
const { parseId, getProductFromEnumValue } = require('./utils')
const baseModels = require('./base-models')
const VERIFICATION = 'tradle.Verification'

module.exports = function stateMutater ({ models }) {

  const privateModels = models.private
  const bizModels = models.biz
  const allModels = models.all
  const build = model => buildResource({ model, models: allModels })

  function validateCustomer (user) {
    user[TYPE] = privateModels.customer.id
    validateResource({
      models: allModels,
      model: privateModels.customer,
      resource: user
    })
  }

  function createCertificate ({ application }) {
    const { product } = application
    return build(bizModels.certificateForProduct[product])
      .set('myProductId', uuid())
      .toJSON()
  }

  function addCertificate ({ user, application, certificate }) {
    const idx = user.applications.findIndex(appState => {
      return application.application.permalink === appState.application.permalink
    })

    if (idx === -1) {
      throw new Error('application not found')
    }

    const appState = user.applications[idx]
    appState.certificate = buildResource.stub({
      models: bizModels.all,
      resource: certificate
    })

    user.certificates.push(appState)
    user.applications.splice(idx, 1)
    validateCustomer(user)
    return appState
  }

  // function revokeCertificate ({ user, application }) {
  //   application.certificate
  // }

  function setProfile ({ user, object }) {
    const { firstName, lastName } = object.profile
    const oldFirstName = user.firstName
    user.firstName = firstName
    if (lastName) {
      user.lastName = lastName
    }
  }

  function getTime (obj, message) {
    return obj._time || obj.time || (message && message.time) || Date.now()
  }

  function importVerification ({ user, object }) {
    addVerification({ user, verification: object, imported: true })
  }

  function createVerifiedItem ({ verification }) {
    return build(privateModels.verifiedItem)
      .set({
        time: getTime(verification),
        link: verification._link,
        permalink: verification._permalink,
        verifiedItem: verification.document
      })
      .toJSON()
  }

  const addApplication = co(function* ({ user, object, message }) {
    const application = toItem({ object, message })
    const appState = build(privateModels.applicationState)
      .set({
        application,
        product: getProductFromEnumValue({ bizModels, value: object.product }),
        forms: []
      })
      .toJSON()

    user.applications.push(appState)
    validateCustomer(user)
    return appState
  })

  function createVerification ({ user, object, verification={} }) {
    const builder = build(baseModels[VERIFICATION])
      .set(verification)
      .set('document', object)

    if (!verification.dateVerified) {
      builder.set('dateVerified', new Date().toISOString())
    }

    if (!verification.sources) {
      const sources = user.importedVerifications.map(v => {
        const { id } = v.verifiedItem
        const { link } = parseId(id)
        if (link === object._link) {
          return id
        }
      })
      .filter(s => s)

      if (sources.length) {
        builder.set('sources', sources.map(id => ({ id })))
      }
    }

    return builder.toJSON()
  }

  function addVerification ({ user, verification, imported }) {
    const vItem = createVerifiedItem({ verification })
    if (imported) {
      user.importedVerifications.push(vItem)
    } else {
      user.issuedVerifications.push(vItem)
    }

    validateCustomer(user)
    return verification
  }

  function addForm ({ user, object, message, application, type, link, permalink }) {
    const time = getTime(object, message)
    const version = toItem({ object, message })
    let formState = application.forms.find(state => {
      if (state.type === type) {
        return state.versions[0].permalink === permalink
      }
    })

    if (!formState) {
      formState = build(privateModels.formState)
        .set({ type, versions: [] })
        .toJSON()

      application.forms.push(formState)
    }

    formState.versions.push(version)
    validateCustomer(user)
  }

  function init (user) {
    const { properties } = privateModels.customer
    for (let propertyName in properties) {
      let prop = properties[propertyName]
      if (prop.type === 'array') {
        if (!user[propertyName]) {
          user[propertyName] = []
        }
      }
    }
  }

  function toItem ({ object, message }) {
    const time = getTime(object, message)
    return build(privateModels.item)
      .set({
        type: object[TYPE],
        permalink: object._permalink,
        time
      })
      .toJSON()
  }

  function findApplication (applications, test) {
    return applications.find(test)
  }

  function getApplicationByPermalink (applications, permalink) {
    return findApplication(applications, appState => {
      return appState.application.permalink === permalink
    })
  }

  function getApplicationByType (applications, type) {
    return applications.filter(appState => appState.product === type)
  }

  function getApplicationPermalink (appState) {
    return appState.application.permalink
  }

  function deduceCurrentApplication (data) {
    const { user, context, type } = data
    if (type === bizModels.application.id) return

    const { applications=[], certificates=[] } = user
    if (context) {
      data.application = getApplicationByPermalink(applications, context) ||
        getApplicationByPermalink(certificates, context)

      if (!data.application) {
        throw new Error(`application ${context} not found`)
      }

      return
    }

    data.application = guessApplicationFromIncomingType(applications, type) ||
      guessApplicationFromIncomingType(certificates, type)

    if (certificates.some(certState => certState === data.application)) {
      data.forCertificate = true
    }

    return data.application
  }

  function guessApplicationFromIncomingType (applications, type) {
    return findApplication(applications, app => {
      const productModel = models.all[app.product]
      return productModel.forms.indexOf(type) !== -1
    })
  }

  function getAppStateContext (appState) {
    return getApplicationPermalink(appState)
  }

  return {
    addApplication,
    createCertificate,
    addCertificate,
    createVerification,
    addVerification,
    importVerification,
    addForm,
    validateCustomer,
    setProfile,
    init,
    getApplicationByType,
    getApplicationByPermalink,
    getApplicationPermalink,
    findApplication,
    deduceCurrentApplication,
    guessApplicationFromIncomingType,
    getAppStateContext
  }
}

function getInfo (objOrId) {
  if (typeof objOrId === 'string') {
    return parseId(objOrId)
  }

  return {
    link: objOrId._link,
    permalink: objOrId._permalink,
    type: objOrId[TYPE],
  }
}
