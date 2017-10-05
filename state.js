const co = require('co').wrap
const uuid = require('uuid/v4')
const { TYPE } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const validateResource = require('@tradle/validate-resource')
const { parseStub, parseId } = validateResource.utils
const {
  getProductFromEnumValue,
  ensureLinks,
  shallowExtend,
  shallowClone,
  pick,
  debug,
  getContext
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
    const { requestFor, forms } = application
    const certModel = bizModels.certificateFor[requestFor]
    // const copy = forms
    //   .map(parseStub)
    //   .map(({ type }) => {
    //     const model = allModels[type]
    //     return Object.keys(model.properties)
    //       .filter(propertyName => propertyName in certModel.properties)
    //       // need to lookup form bodies for this
    //       .map(propertyName => form[propertyName])
    //   })

    // return build(certModel)
    //   .set('myProductId', uuid())
    //   .toJSON()

    return {
      [TYPE]: certModel.id,
      myProductId: uuid()
    }
  }

  /**
   * add certificate to application state
   * @param {User}             options.user
   * @param {application} options.application
   * @param {Certification}    options.certificate
   */
  function addCertificate ({ req, user, application, certificate }) {
    if (!user) user = req.user
    if (!application) application = req.application

    const idx = getApplicationStubIndex({
      applications: user.applications,
      application
    })

    if (idx === -1) {
      const certIdx = getApplicationStubIndex({
        applications: user.applicationsApproved,
        application
      })

      if (certIdx === -1) {
        throw new Error('application not found')
      }

      throw new Error('application was already approved')
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
        dateEvaluated: Date.now()
      })
      .toJSON()

    shallowExtend(application, updated)
    setApplicationStatus({ application, status: 'approved' })
    user.applicationsApproved.push(user.applications[idx])
    user.applications.splice(idx, 1)
    validateCustomer(user)
    return application
  }

  function moveToDenied ({ user, application }) {
    const idx = getApplicationStubIndex({
      applications: user.applications,
      application
    })

    if (idx === -1) {
      throw new Error('application not found')
    }

    user.applicationsDenied.push(user.applications[idx])
    user.applications.splice(idx, 1)
    validateCustomer(user)
    return application
  }

  // function revokeCertificate ({ user, application }) {
  //   application.certificate
  // }

  function setProfile ({ user, object }) {
    const { firstName, lastName } = object.profile
    // const oldFirstName = user.firstName
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

  function createApplication ({ user, object }) {
    const requestFor = getProductFromEnumValue({
      bizModels,
      value: object.requestFor
    })

    const application = build(privateModels.application)
      .set({
        applicant: user.identity,
        context: getContext({
          model: allModels[object[TYPE]],
          resource: object
        }),
        request: object,
        requestFor,
        forms: []
      })
      .toJSON()

    setApplicationStatus({ application, status: 'started' })
    return application
  }

  function updateApplicationStub ({ user, application }) {
    const updated = [
      user.applications,
      user.applicationsApproved,
      user.applicationsDenied
    ].some(applications => {
      const idx = getApplicationStubIndex({ applications, application })
      if (idx !== -1) {
        applications[idx] = createApplicationStub({ application })
        return true
      }
    })

    if (!updated) {
      throw new Error('no matching application stub found')
    }
  }

  function getApplicationStubIndex ({ applications, application }) {
    return applications.findIndex(application2 => {
      return application._permalink === application2.statePermalink
    })
  }

  function hasApplication ({ applications, application }) {
    return getApplicationStubIndex({ applications, application }) !== -1
  }

  function createApplicationStub ({ application }) {
    const copy = Object.keys(privateModels.applicationStub.properties)
      .filter(propertyName => propertyName in privateModels.application.properties)

    return build(privateModels.applicationStub)
      .set(pick(application, copy))
      .set({
        statePermalink: buildResource.permalink(application)
      })
      .toJSON()
  }

  function updateApplication ({ application, properties }) {
    buildResource.set({
      models: models.all,
      model: models.private.application,
      resource: application,
      properties
    })

    return application
  }

  function setApplicationStatus ({ application, status }) {
    const now = Date.now()
    const properties = { status, dateModified: now }
    switch (status) {
    case 'completed':
      properties.dateCompleted = now
      break
    case 'started':
      properties.dateStarted = now
      break
    case 'approved':
    case 'denied':
      properties.dateEvaluated = now
      break
    }

    updateApplication({ application, properties })
    return application
  }

  /**
   * add application state
   * @param {User}             options.user
   * @param {Application Form} options.object  [description]
   * @param {tradle.Message}   options.message [description]
   */
  function addApplication ({ user, application }) {
    ensureLinks(application)
    debug('added application with context: ' + application.context)
    const stub = createApplicationStub({ application })
    user.applications.push(stub)
    validateCustomer(user)
    return stub
  }

  function createVerification ({ req, user, object, verification={} }) {
    if (!user) user = req.user

    const builder = build(baseModels[VERIFICATION])
      .set(verification)
      .set('document', object)

    if (!verification.dateVerified) {
      builder.set('dateVerified', new Date().getTime())
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

  function addForm ({ user, object, application }) {
    if (!application.forms) {
      application.forms = []
    }

    const stub = buildResource.stub({
      models: allModels,
      resource: object
    })

    application.forms.push(stub)
    validateCustomer(user)
    return stub
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

  function setIdentity ({ user, identity }) {
    user.identity = buildResource.stub({
      models: allModels,
      resource: identity
    })
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

  function getApplicationByContext (applications, context) {
    return findApplication(applications, application => {
      return application.context === context
    })
  }

  function getApplicationsByType (applications, type) {
    return applications.filter(application => application.requestFor === type)
  }

  function getFormsByType (forms, type) {
    return forms.filter(stub => parseStub(stub).type === type)
  }

  function deduceCurrentApplication (data) {
    const { user, context, type } = data
    if (type === bizModels.productRequest.id) return

    const { applications=[], applicationsApproved=[] } = user
    let application
    if (context) {
      application = getApplicationByContext(applications, context) ||
        getApplicationByContext(applicationsApproved, context)

      if (!application) {
        debug(`application ${context} not found`)
      }
    } else {
      application = guessApplicationFromIncomingType(applications, type) ||
        guessApplicationFromIncomingType(applicationsApproved, type)

      if (applicationsApproved.some(appState => appState === application)) {
        data.forCertificate = true
      }
    }

    if (application) {
      debug('deduced current application, context: ' + application.context)
    } else {
      debug(`could not deduce current application`)
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
    createApplicationStub,
    updateApplicationStub,
    setApplicationStatus,
    moveToDenied,
    updateApplication,
    addForm,
    validateCustomer,
    setProfile,
    setIdentity,
    init,
    getFormsByType,
    hasApplication,
    getApplicationsByType,
    getApplicationByContext,
    findApplication,
    deduceCurrentApplication,
    guessApplicationFromIncomingType,
    getApplicationContext,
    newRequestState
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

function newRequestState (data) {
  return shallowClone(data, {
    sendQueue: [],
    object: data.payload || data.object,
    payload: data.payload || data.object
  })
}
