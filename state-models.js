const baseModels = require('./base-models')
const {
  VERIFIED_ITEM,
  APPLICATION,
  APPLICATION_STUB,
  TS_AND_CS_STATE,
  CUSTOMER,
  ROLE
} = require('./types')

const application = baseModels[APPLICATION]
const applicationStub = baseModels[APPLICATION_STUB]
const role = baseModels[ROLE]
const tsAndCsState = baseModels[TS_AND_CS_STATE]
const customer = baseModels[CUSTOMER]
const verifiedItem = baseModels[VERIFIED_ITEM]

module.exports = {
  application,
  applicationStub,
  role,
  tsAndCsState,
  customer,
  verifiedItem
}
