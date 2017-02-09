
module.exports = [
  {
    type: 'tradle.Model',
    title: 'Over 18',
    id: 'age.police.Over18',
    interfaces: ['tradle.Message'],
    subClassOf: 'tradle.FinancialProduct',
    forms: [
      'tradle.PhotoID',
      'tradle.Selfie',
      'age.police.ParentContactInfo'
    ],
    properties: {
      isOver18: {
        type: 'boolean'
      }
    }
  },
  {
    type: 'tradle.Model',
    title: 'Under 120',
    id: 'age.police.Under120',
    interfaces: ['tradle.Message'],
    subClassOf: 'tradle.FinancialProduct',
    forms: [
      'tradle.Selfie'
    ],
    properties: {
      isOver18: {
        type: 'boolean'
      }
    }
  },
  {
    type: 'tradle.Model',
    title: 'Parent Contact Info',
    id: 'age.police.ParentContactInfo',
    interfaces: ['tradle.Message'],
    subClassOf: 'tradle.Form',
    properties: {
      parentPhones: {
        type: 'array',
        inlined: true,
        items: {
          ref: 'tradle.Phone'
        }
      }
    }
  }
]
