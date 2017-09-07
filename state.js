const co = require('co').wrap
const uuid = require('uuid/v4')
const { TYPE } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const validateResource = require('@tradle/validate-resource')
const {
  parseId,
  getProductFromEnumValue,
  ensureLinks,
  shallowExtend
} = require('./utils')

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
    const { requestFor } = application
    return build(bizModels.certificateFor[requestFor])
      .set('myProductId', uuid())
      .toJSON()
  }

  /**
   * add certificate to application state
   * @param {User}             options.user
   * @param {application} options.application
   * @param {Certification}    options.certificate
   */
  function addCertificate ({ user, application, certificate }) {
    const idx = user.applications.findIndex(application2 => {
      return application._permalink === application2.statePermalink
    })

    if (idx === -1) {
      throw new Error('application not found')
    }

    // lookup, modify stored version
    const updated = buildResource({
        models: allModels,
        model: privateModels.application,
        resource: application,
        mutate: true
      })
      .set({
        certificate,
        status: 'approved'
      })
      .toJSON()

    shallowExtend(application, updated)
    user.certificates.push(user.applications[idx])
    user.applications.splice(idx, 1)
    validateCustomer(user)
    return application
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

  function createApplication ({ object, message }) {
    // const request = toItem({ object, message })
    const requestFor = getProductFromEnumValue({
      bizModels,
      value: object.requestFor
    })

    return build(privateModels.application)
      .set({
        dateStarted: Date.now(),
        status: 'started',
        context: buildResource.permalink(object),
        request: object,
        requestFor,
        forms: []
      })
      .toJSON()
  }

  function createApplicationStub ({ application }) {
    return build(privateModels.applicationStub)
      .set({
        requestFor: application.requestFor,
        context: application.context,
        statePermalink: buildResource.permalink(application),
      })
      .toJSON()
  }

  /**
   * add application state
   * @param {User}             options.user
   * @param {Application Form} options.object  [description]
   * @param {tradle.Message}   options.message [description]
   */
  function addApplication ({ user, application }) {
    ensureLinks(application)
    const stub = createApplicationStub({ application })
    user.applications.push(stub)
    validateCustomer(user)
    return stub
  }

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
    const formItem = toItem({ object, message })
    addFormItem({ application, formItem })
    validateCustomer(user)
    return formItem
  }

  function addFormItem ({ application, formItem }) {
    if (!application.forms) {
      application.forms = []
    }

    application.forms.push(formItem)
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
    return findApplication(applications, application => {
      return application.request.permalink === permalink
    })
  }

  function getApplicationByType (applications, type) {
    return applications.filter(application => application.requestFor === type)
  }

  function deduceCurrentApplication (data) {
    const { user, context, type } = data
    if (type === bizModels.productRequest.id) return

    const { applications=[], certificates=[] } = user
    let application
    if (context) {
      application = getApplicationByPermalink(applications, context) ||
        getApplicationByPermalink(certificates, context)

      if (!application) {
        throw new Error(`application ${context} not found`)
      }
    } else {
      application = guessApplicationFromIncomingType(applications, type) ||
        guessApplicationFromIncomingType(certificates, type)

      if (certificates.some(certState => certState === application)) {
        data.forCertificate = true
      }
    }

    data.application = application
    return application
  }

  function guessApplicationFromIncomingType (applications, type) {
    return findApplication(applications, app => {
      const productModel = models.all[app.requestFor]
      return productModel.forms.indexOf(type) !== -1
    })
  }

  function getApplicationContext (application) {
    return application.context
  }

  return {
    createApplication,
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
    findApplication,
    deduceCurrentApplication,
    guessApplicationFromIncomingType,
    getApplicationContext
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
