const Gen = require('./gen')
const { getValues } = require('./utils')

module.exports = namespace => {
  // const profile = {
  //   type: 'tradle.Model',
  //   title: 'Profile',
  //   id: `${namespace}.Profile`,
  //   properties: {
  //     firstName: {
  //       type: 'string'
  //     },
  //     lastName: {
  //       type: 'string'
  //     }
  //   }
  // }

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
      link: {
        type: 'string'
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

  const formState = {
    type: 'tradle.Model',
    title: 'Form State',
    id: `${namespace}.FormState`,
    inlined: true,
    properties: {
      type: {
        type: 'string'
      },
      versions: {
        type: 'array',
        items: {
          type: 'object',
          ref: item.id
        }
      }
    }
  }

  const applicationState = {
    type: 'tradle.Model',
    title: 'Application State',
    id: `${namespace}.ApplicationState`,
    inlined: true,
    properties: {
      product: {
        type: 'object',
        ref: Gen.id.productList({ namespace })
      },
      forms: {
        type: 'array',
        items: {
          ref: 'tradle.Form'
        }
      },
      certificate: {
        type: 'object',
        ref: 'tradle.MyProduct'
      },
      application: {
        type: 'object',
        ref: item.id
      }
    }
  }

  const customer = {
    type: 'tradle.Model',
    title: 'Customer',
    id: `${namespace}.Customer`,
    properties: {
      id: {
        type: 'string'
      },
      firstName: {
        type: 'string'
      },
      lastName: {
        type: 'string'
      },
      identity: {
        type: 'object',
        ref: 'tradle.Identity'
      },
      // latestApplication: {
      //   type: 'object',
      //   ref:
      // },
      // profile: {
      //   type: 'object',
      //   inlined: true,
      //   ref: `${namespace}.Profile`
      // },
      forms: {
        type: 'array',
        inlined: true,
        items: {
          type: 'object',
          ref: formState.id
        }
      },
      applications: {
        type: 'array',
        inlined: true,
        items: {
          type: 'object',
          ref: applicationState.id
        }
      },
      products: {
        type: 'array',
        inlined: true,
        items: {
          type: 'object',
          ref: applicationState.id
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
      isEmployee: {
        type: 'boolean'
      },
      relationshipManager: {
        type: 'object',
        ref: 'tradle.Identity'
      }
    },
    required: ['id']
  }

  const ret = {
    // profile,
    customer,
    formState,
    applicationState,
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
