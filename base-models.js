const shallowClone = require('xtend')
const base = require('@tradle/models').models
const custom = require('@tradle/custom-models')

module.exports = toModelsMap(base.concat(custom))

function toModelsMap (arr) {
  if (!Array.isArray(arr)) return shallowClone(arr)

  const obj = {}
  arr.forEach(item => obj[item.id] = item)
  return obj
}
