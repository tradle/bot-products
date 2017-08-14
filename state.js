const co = require('co').wrap
const uuid = require('uuid/v4')
const { TYPE } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const validateResource = require('@tradle/validate-resource')
const { parseId, getProductFromEnumValue } = require('./utils')
const baseModels = require('./base-models')
const VERIFICATION = 'tradle.Verification'

module.exports = function stateMutater ({ models, appModels, privateModels }) {

  function validateCustomer (user) {
    user[TYPE] = privateModels.customer.id
    validateResource({
      models,
      model: privateModels.customer,
      resource: user
    })
  }

  function createCertificate ({ application }) {
    const product = getProductFromEnumValue({
      appModels,
      value: application.product
    })

    return buildResource({
      models,
      model: appModels.certificateForProduct[product],
      resource: {
        myProductId: uuid()
      }
    })
    .toJSON()
  }

  function addCertificate ({ user, application, certificate }) {
    const idx = user.applications.findIndex(appState => {
      return application._link === appState.application.link
    })

    if (idx === -1) {
      throw new Error('application not found')
    }

    user.products.push(user.applications[idx])
    user.applications.splice(idx, 1)
    validateCustomer(user)
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
    return buildResource({
      model: privateModels.verifiedItem,
      models,
      resource: {
        time: getTime(verification),
        link: verification._link,
        permalink: verification._permalink,
        verifiedItem: verification.document
      }
    })
    .toJSON()
  }

  function addApplication ({ user, object, message, type }) {
    const application = buildResource({
      models,
      model: privateModels.item,
      resource: {
        type: object[TYPE],
        link: object._link,
        permalink: object._permalink,
        time: getTime(object, message)
      }
    })
    .toJSON()

    const appState = buildResource({
      models,
      model: privateModels.applicationState,
      resource: {
        product: object.product,
        application
      }
    })
    .toJSON()

    user.applications.push(appState)
    validateCustomer(user)
    return appState
  }

  function createVerification ({ user, object, verification={} }) {
    const builder = buildResource({
      models,
      model: baseModels[VERIFICATION],
      resource: verification
    })
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

  function addForm ({ user, object, message, type, link, permalink }) {
    const version = buildResource({
      models,
      model: privateModels.item,
      resource: {
        type,
        link,
        permalink,
        time: getTime(object, message)
      }
    })
    .toJSON()

    let formState = user.forms.find(state => {
      if (state.type === type) {
        return state.versions[0].permalink === permalink
      }
    })

    if (!formState) {
      formState = buildResource({
        models,
        model: privateModels.formState,
        resource: {
          type,
          versions: []
        }
      })
      .toJSON()

      user.forms.push(formState)
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
    init
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
