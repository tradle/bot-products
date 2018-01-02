const _ = require('lodash')
const co = require('co').wrap
const uuid = require('uuid/v4')
const { TYPE } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const validateResource = require('@tradle/validate-resource')
const { parseStub, parseId } = validateResource.utils
const {
  ensureLinks,
  debug,
  getContext,
  getLinkFromResourceOrStub
} = require('./utils')

const baseModels = require('./base-models')
const VERIFICATION = 'tradle.Verification'
const VERIFIED_ITEM = 'tradle.VerifiedItem'
const STATUS = {
  started: 'started',
  completed: 'completed',
  approved: 'approved',
  denied: 'denied'
}

module.exports = function stateMutater ({ models }) {

  const privateModels = models.private
  const bizModels = models.biz
  const allModels = models.all
  const build = model => buildResource({ model, models: allModels })

  const validateCustomer = (user) => {
    user[TYPE] = privateModels.customer.id
    validateResource({
      models: allModels,
      model: privateModels.customer,
      resource: user
    })
  }

  const createCertificate = ({ application }) => {
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
  const addCertificate = ({ req, user, application, certificate }) => {
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

    _.extend(application, updated)
    setApplicationStatus({ application, status: STATUS.approved })
    user.applicationsApproved.push(user.applications[idx])
    user.applications.splice(idx, 1)
    validateCustomer(user)
    return application
  }

  const moveToDenied = ({ user, application }) => {
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

  // const revokeCertificate = ({ user, application }) => {
  //   application.certificate
  // }

  const setProfile = ({ user, object }) => {
    const { firstName, lastName } = object.profile
    // const oldFirstName = user.firstName
    user.firstName = firstName
    if (lastName) {
      user.lastName = lastName
    }
  }

  const getTime = (obj, message) => {
    return obj._time || obj.time || (message && message.time) || Date.now()
  }

  const importVerification = ({ user, application, verification }) => {
    addVerification({ user, application, verification, imported: true })
  }

  const createVerifiedItem = ({ verification }) => {
    return build(allModels[VERIFIED_ITEM])
      .set({
        verification,
        item: verification.document
      })
      .setVirtual({
        _verifiedBy: verification._author
      })
      .toJSON()
  }

  const createApplication = ({ user, object }) => {
    const { requestFor } = object
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

  const updateApplicationStub = ({ user, application }) => {
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

  const getApplicationStubIndex = ({ applications, application }) => {
    return applications.findIndex(application2 => {
      return application._permalink === application2.statePermalink
    })
  }

  const hasApplication = ({ applications, application }) => {
    return getApplicationStubIndex({ applications, application }) !== -1
  }

  const createApplicationStub = ({ application }) => {
    const copy = Object.keys(privateModels.applicationStub.properties)
      .filter(propertyName => propertyName in privateModels.application.properties)

    return build(privateModels.applicationStub)
      .set(_.pick(application, copy))
      .set({
        statePermalink: buildResource.permalink(application)
      })
      .toJSON()
  }

  const updateApplication = ({ application, properties={} }) => {
    if (!properties.dateModified) {
      properties.dateModified = Date.now()
    }

    buildResource.set({
      models: models.all,
      model: models.private.application,
      resource: application,
      properties
    })

    buildResource.setVirtual(application, {
      _time: application.dateModified
    })

    return application
  }

  const setApplicationStatus = ({ application, status }) => {
    if (status === application.status) return

    const now = Date.now()
    const properties = { status, dateModified: now }
    switch (status) {
    case STATUS.completed:
      properties.dateCompleted = now
      break
    case STATUS.started:
      properties.dateStarted = now
      break
    case STATUS.approved:
    case STATUS.denied:
      properties.dateEvaluated = now
      break
    default:
      throw new Error(`invalid application status: ${status}`)
    }

    updateApplication({ application, properties })
    return application
  }

  const isApplicationCompleted = (application) => {
    return application.status === 'completed'
  }

  /**
   * add application state
   * @param {User}             options.user
   * @param {Application Form} options.object  [description]
   * @param {tradle.Message}   options.message [description]
   */
  const addApplication = ({ user, application }) => {
    ensureLinks(application)
    debug('added application with context: ' + application.context)
    const stub = createApplicationStub({ application })
    user.applications.push(stub)
    validateCustomer(user)
    return stub
  }

  const createVerification = ({ req, user, application, object, verification={} }) => {
    if (!user) user = req.user

    const oLink = getLinkFromResourceOrStub(object)
    const builder = build(baseModels[VERIFICATION])
      .set(verification)
      .set('document', object)

    if (!verification.dateVerified) {
      builder.set('dateVerified', new Date().getTime())
    }

    builder.set('time', builder.get('dateVerified'))

    if (!verification.sources && application) {
      const { verificationsImported=[] } = application
      const sources = verificationsImported.map(verifiedItem => {
        const { id } = verifiedItem.item
        const { link } = parseId(id)
        if (link === oLink) {
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

  const addVerification = ({ user, application, verification, imported }) => {
    if (!application) {
      throw new Error('expected "application"')
    }

    const vItem = createVerifiedItem({ verification })
    if (imported) {
      if (!application.verificationsImported) {
        application.verificationsImported = []
      }

      application.verificationsImported.push(vItem)
    } else {
      if (!application.verificationsIssued) {
        application.verificationsIssued = []
      }

      application.verificationsIssued.push(vItem)
    }

    validateCustomer(user)
    return verification
  }

  const addForm = ({ user, object, application }) => {
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

  const init = (user) => {
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

  const setIdentity = ({ user, identity }) => {
    user.identity = buildResource.stub({
      models: allModels,
      resource: identity
    })
  }

  const toItem = ({ object, message }) => {
    const time = getTime(object, message)
    return build(privateModels.item)
      .set({
        type: object[TYPE],
        permalink: object._permalink,
        time
      })
      .toJSON()
  }

  const findApplication = (applications, test) => {
    return applications.find(test)
  }

  const getApplicationByContext = (applications, context) => {
    return findApplication(applications, application => application.context === context)
  }

  const getApplicationsByType = (applications, type) =>
    applications.filter(application => application.requestFor === type)

  const getFormsByType = (forms, type) =>
    forms.filter(stub => parseStub(stub).type === type)

  const createFilterForType = query => ({ type }) => type === query

  const getLatestForm = (forms, filter) => {
    let result
    forms.slice().reverse().some(stub => {
      const parsed = parseStub(stub)
      if (filter(parsed)) {
        result = parsed
        return true
      }
    })

    return result
  }

  const getLatestFormByType = (forms, type) =>
    getLatestForm(forms, createFilterForType(type))

  const guessApplicationFromIncomingType = (applications, type) => {
    return findApplication(applications, app => {
      const productModel = models.all[app.requestFor]
      return productModel.forms.indexOf(type) !== -1
    })
  }

  const getApplicationContext = (application) => {
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
    getLatestForm,
    getLatestFormByType,
    hasApplication,
    getApplicationsByType,
    getApplicationByContext,
    findApplication,
    guessApplicationFromIncomingType,
    getApplicationContext,
    newRequestState,
    isApplicationCompleted,
    status: STATUS
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
  const payload = data.payload || data.object
  return _.extend({}, data, {
    sendQueue: [],
    object: payload,
    payload,
    type: data.type || (payload && payload[TYPE])
  })
}
