const Gen = require('./gen')
const { getValues } = require('./utils')

module.exports = namespace => {
  const item = {
    type: 'tradle.Model',
    title: 'Item',
    id: `${namespace}.Item`,
    inlined: true,
    properties: {
      type: {
        type: 'string',
      },
      time: {
        type: 'number',
      },
      permalink: {
        type: 'string'
      }
    }
  }

  const verifiedItem = {
    type: 'tradle.Model',
    title: 'Verified Item',
    id: `${namespace}.VerifiedItem`,
    inlined: true,
    properties: {
      time: {
        type: 'number',
      },
      link: {
        type: 'string'
      },
      permalink: {
        type: 'string'
      },
      verifiedItem: {
        type: 'object',
        inlined: true,
        ref: item.id
      }
    }
  }

  // const formState = {
  //   type: 'tradle.Model',
  //   title: 'Form State',
  //   id: `${namespace}.FormState`,
  //   inlined: true,
  //   properties: {
  //     type: {
  //       type: 'string'
  //     },
  //     dateSubmitted: {
  //       type: 'date'
  //     },
  //     versions: {
  //       type: 'array',
  //       items: {
  //         type: 'object',
  //         ref: item.id
  //       }
  //     }
  //   }
  // }

  const role = {
    type: 'tradle.Model',
    title: 'Role',
    subClassOf: 'tradle.Enum',
    id: `${namespace}.Role`,
    properties: {
      role: {
        type: 'string'
      }
    },
    enum: [
      { id: 'employee', title: 'Employee' }
    ]
  }

  const applicationStatus = {
    type: 'tradle.Model',
    title: 'Application Status',
    subClassOf: 'tradle.Enum',
    id: `${namespace}.ApplicationStatus`,
    properties: {
      status: {
        type: 'string'
      }
    },
    enum: [
      { id: 'started', title: 'Started' },
      { id: 'completed', title: 'Completed' },
      { id: 'approved', title: 'Approved' },
      { id: 'denied', title: 'Denied' },
    ]
  }

  const application = {
    type: 'tradle.Model',
    title: 'Application',
    id: `${namespace}.Application`,
    properties: {
      identity: {
        type: 'object',
        ref: 'tradle.Identity'
      },
      relationshipManager: {
        type: 'object',
        ref: 'tradle.Identity'
      },
      status: {
        type: 'object',
        ref: applicationStatus.id
      },
      dateStarted: {
        type: 'date',
      },
      dateCompleted: {
        type: 'date',
      },
      dateEvaluated: {
        type: 'date',
      },
      dateModified: {
        type: 'date'
      },
      // permalink of ProductRequest
      context: {
        type: 'string'
      },
      request: {
        type: 'object',
        ref: 'tradle.Form'
      },
      requestFor: {
        type: 'string'
      },
      forms: {
        type: 'array',
        inlined: true,
        items: {
          ref: item.id
        }
      },
      // prob better to store stub with state
      // e.g. permalink, revoked: false,
      certificate: {
        type: 'object',
        ref: 'tradle.MyProduct'
      }
    }
  }

  const applicationStub = {
    type: 'tradle.Model',
    title: 'Application Stub',
    id: `${namespace}.ApplicationStub`,
    inlined: true,
    properties: {
      dateModified: {
        type: 'date'
      },
      requestFor: {
        type: 'string'
      },
      statePermalink: {
        type: 'string'
      },
      context: {
        type: 'string'
      },
      status: {
        type: 'object',
        ref: applicationStatus.id
      }
    }
  }

  const customer = {
    type: 'tradle.Model',
    title: 'Customer',
    id: `${namespace}.Customer`,
    properties: {
      lastName: {
        type: 'string'
      },
      identity: {
        type: 'object',
        ref: 'tradle.Identity'
      },
      applications: {
        type: 'array',
        inlined: true,
        items: {
          type: 'object',
          ref: applicationStub.id
        }
      },
      certificates: {
        type: 'array',
        inlined: true,
        items: {
          type: 'object',
          ref: applicationStub.id
        }
      },
      issuedVerifications: {
        type: 'array',
        inlined: true,
        items: {
          type: 'object',
          ref: verifiedItem.id
        }
      },
      importedVerifications: {
        type: 'array',
        inlined: true,
        items: {
          type: 'object',
          ref: verifiedItem.id
        }
      },
      givenName: {
        type: 'string'
      },
      surname: {
        type: 'string'
      },
      roles: {
        type: 'array',
        items: {
          ref: role.id
        }
      }
    }
  }

  const ret = {
    // profile,
    customer,
    // formState,
    applicationStatus,
    application,
    applicationStub,
    role,
    item,
    verifiedItem
  }

  const all = {}
  for (let shortName in ret) {
    let model = ret[shortName]
    all[model.id] = model
  }

  ret.all = all
  return ret
}
