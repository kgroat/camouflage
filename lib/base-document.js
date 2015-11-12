"use strict";

var _ = require('lodash');
var DB = require('./clients').getClient;
var isSupportedType = require('./validate').isSupportedType;
var isValidType = require('./validate').isValidType;
var isInChoices = require('./validate').isInChoices;
var isArray = require('./validate').isArray;
var isDocument = require('./validate').isDocument;
var isEmbeddedDocument = require('./validate').isEmbeddedDocument;
var isString = require('./validate').isString;
var isNumber = require('./validate').isNumber;

var normalizeType = function(property) {
    // TODO: Only copy over stuff we support

    var typeDeclaration = {};
    if (property.type) {
        typeDeclaration = property;
    } else if (isSupportedType(property)) {
        typeDeclaration.type = property;
    } else {
        throw new Error('Unsupported type or bad variable. ' +
            'Remember, non-persisted objects must start with an underscore (_). Got:', property);
    }

    return typeDeclaration;
};

// For more handler methods:
// https://developer.mozilla.org/en/docs/Web/JavaScript/Reference/Global_Objects/Proxy

var schemaProxyHandler = {
    get: function(target, propKey, receiver) {
        // Return current value, if set
        if (propKey in target._values) {
            return target._values[propKey];
        }

        // Alias 'id' and '_id'
        if (propKey === 'id') {
            return target._values._id;
        }

        return Reflect.get(target, propKey, receiver);
    },

    set: function(target, propKey, value, receiver) {
        if (propKey in target._schema) {
            target._values[propKey] = value;
            return true;
        }

        // Alias 'id' and '_id'
        if (propKey === 'id') {
            target._values._id = value;
            return true;
        }

        return Reflect.set(target, propKey, value, receiver);
    },

    deleteProperty: function(target, propKey) {
        delete target._schema[propKey];
        delete target._values[propKey];
        return true;
    },

    has: function(target, propKey) {
        return propKey in target._schema || Reflect.has(target, propKey);
    }
};

class BaseDocument {
    constructor() {
        this._schema = {                            // Defines document structure/properties
            _id: { type: DB().nativeIdType() },     // Native ID to backend database
        };
        this._values = {};                          // Contains values for properties defined in schema
    }

    // TODO: Is there a way to tell if a class is
    // a subclass of something? Until I find out
    // how, we'll be lazy use this.
    static documentClass() {
        throw new TypeError('You must override documentClass (static).');
    }

    documentClass() {
        throw new TypeError('You must override documentClass.');
    }

    get id() {
        return this._values._id;
    }

    set id(id) {
        this._values._id = id;
    }

    schema(extension) {
        if (!extension) return;
        _.keys(extension).forEach(function(k) {
            extension[k] = normalizeType(extension[k]);
        });
        _.assign(this._schema, extension);
    }

    /*
     * Pre/post Hooks
     *
     * To add a hook, the extending class just needs
     * to override the appropriate hook method below.
     */

    preValidate() { }

    postValidate() { }

    preSave() { }

    postSave() { }

    preDelete() { }

    postDelete() { }

    // TODO : EMBEDDED
    // Need to share this with embedded
    generateSchema() {
        var that = this;

        _.keys(this).forEach(function(k) {
            // Ignore private variables
            if (_.startsWith(k, '_')) {
                return;
            }

            // Normalize the type format
            that._schema[k] = normalizeType(that[k]);

            // Assign a default if needed
            if (isArray(that._schema[k].type)) {
                that._values[k] = that.getDefault(k) || [];
            } else {
                that._values[k] = that.getDefault(k);
            }

            // Should we delete these member variables so they
            // don't get in the way? Probably a waste of time
            // since the Proxy intercepts all gets/sets to them.
            //delete that[k];
        });
    }

    validate() {
        var that = this;

        _.keys(that._values).forEach(function(key) {
            var value = that._values[key];

            // TODO: This should probably be in Document, not BaseDocument
            if (value !== null && value !== undefined &&
                value.documentClass && value.documentClass() === 'embedded') {
                value.validate();
                return;
            }

            if (!isValidType(value, that._schema[key].type)) {
                // TODO: Formatting should probably be done somewhere else
                var typeName = null;
                var valueName = null;
                if (Array.isArray(that._schema[key].type)) {
                    typeName = '[' + that._schema[key].type[0].name + ']';
                } else {
                    typeName = that._schema[key].type.name;
                }

                if (Array.isArray(value)) {
                    // TODO: Not descriptive enough! Strings can look like numbers
                    valueName = '[' + value.toString() + ']';
                } else {
                    valueName = typeof(value);
                }
                throw new Error('Value assigned to ' + that._meta.collection + '.' + key +
                    ' should be ' + typeName + ', got ' + valueName);
            }

            if (that._schema[key].match && isString(value) && !that._schema[key].match.test(value)) {
                throw new Error('Value assigned to ' + that._meta.collection + '.' + key +
                    ' does not match the regex/string ' + that._schema[key].match.toString() + '. Value was ' + value);
            }

            if (!isInChoices(that._schema[key].choices, value)) {
                throw new Error('Value assigned to ' + that._meta.collection + '.' + key +
                    ' should be in [' + that._schema[key].choices.join(', ') + '], got ' + value);
            }

            if (that._schema[key].min && value < that._schema[key].min) {
                throw new Error('Value assigned to ' + that._meta.collection + '.' + key +
                    ' is less than min, ' + that._schema[key].min + ', got ' + value);
            }

            if (that._schema[key].max && value > that._schema[key].max) {
                throw new Error('Value assigned to ' + that._meta.collection + '.' + key +
                    ' is less than max, ' + that._schema[key].max + ', got ' + value);
            }

            if (typeof(that._schema[key].validate) === 'function' && !that._schema[key].validate(value)) {
                throw new Error('Value assigned to ' + that._meta.collection + '.' + key +
                    ' failed custom validator. Value was ' + value);
            }
        });
    }

    /*
     * Right now this only canonicalizes dates (integer timestamps
     * get converted to Date objects), but maybe we should do the
     * same for strings (UTF, Unicode, ASCII, etc)?
     */
    canonicalize() {
        var that = this;

        _.keys(that._values).forEach(function(key) {
            var value = that._values[key];

            if (that._schema[key].type === Date && isNumber(value)) {
                that._values[key] = new Date(value);
            } else if (value !== null && value !== undefined &&
                value.documentClass && value.documentClass() === 'embedded') {
                // TODO: This should probably be in Document, not BaseDocument
                value.canonicalize();
                return;
            }
        });
    }

    static create(data) {
        if (typeof(data) !== 'undefined') {
            return this._fromData(data);
        }
        return this._instantiate();
    }

    static _instantiate() {
        var instance = new this();
        instance.generateSchema();
        return new Proxy(instance, schemaProxyHandler);
    }

    // TODO: Should probably move some of this to
    // Embedded and Document classes since Base shouldn't
    // need to know about child classes
    static _fromData(datas) {
        if (!isArray(datas)) {
            return this._fromDataSingle(datas);
        }
        return datas.map(this._fromDataSingle.bind(this));
    }

    static _fromDataSingle(d){
        var instance = this._instantiate();
        return instance.fill(d);
    }

    populate() {
        return BaseDocument.populate(this);
    }

    fill(newValues) {
        var instance = this;
        if(newValues === null || newValues === undefined){
            return this;
        }
        if(DB().isNativeId(newValues)){
            this._values._id = newValues;
            return this;
        }
        _.keys(newValues).forEach(function(key) {

            var value = null;
            if (!(key in newValues)) {
                value = instance._values[key];
                if(value === undefined) {
                    value = instance.getDefault(key);
                }
            } else {
                value = newValues[key];
            }

            if (key in instance._schema) {
                var type = instance._schema[key].type;
                var typeIsArray = isArray(type);
                if (typeIsArray) {
                    type = type[0];
                }

                if (type.prototype instanceof BaseDocument) {
                    if(value === null || value === undefined){
                        instance._values[key] = value;
                    } else if(instance._values[key] instanceof BaseDocument){
                        instance._values[key].fill(value);
                    } else if(typeof value === 'object' && !(DB().isNativeId(value))) {
                        instance._values[key] = type._fromData(value);
                    } else {
                        instance._values[key] = value;
                    }
                } else if(key === '_id' || key === 'id') {
                    instance._values[key] = DB().toNativeId(value);
                } else {
                    instance._values[key] = value;
                }
            } else if (key in instance) {
                instance[key] = value;
            }
        });
        return this;
    }

    // TODO : EMBEDDED
    // 
    static populate(docs) {
        if (!docs) return Promise.all([]);

        var documents = null;

        if (!isArray(docs)) {
            documents = [docs];
        } else if (docs.length < 1) {
            return Promise.all(docs);
        } else {
            documents = docs;
        }

        // TODO: Bad assumption: Not all documents in the database will have the same schema...
        // Hmm, if this is true, thats an error on the user. Right?
        var anInstance = documents[0];

        var keyDefs = _.keys(anInstance._schema).filter(function(key) {
            // Handle array of references (ex: { type: [MyObject] })
            return (isArray(anInstance._schema[key].type) &&
                anInstance._schema[key].type.length > 0 &&
                isDocument(anInstance._schema[key].type[0]))
                || ((isString(anInstance[key]) || DB().isNativeId(anInstance[key])) &&
                isDocument(anInstance._schema[key].type));
        }).map(function(key){
            var type = anInstance._schema[key].type;
            var isKeyForArray = isArray(type);
            if(isKeyForArray){
                type = type[0]
            }
            return {
                key: key,
                type: type,
                isArray: isKeyForArray
            };
        });

        var cache = new Map();
        function loadFromCache(type, id){
            var typeCache = cache.get(type);
            if(!typeCache){
                typeCache = new Map();
                cache.set(type, typeCache);
            }
            var loadPromise = typeCache.get(id);
            if(!loadPromise){
                loadPromise = type.loadById(id, { populate: false });
                typeCache.set(id, loadPromise);
            }
            return loadPromise;
        }

        var loadPromises = [];
        keyDefs.forEach(function(keyDef) {
            documents.forEach(function(d) {
                if(keyDef.isArray && d[keyDef.key]){
                    var idList = d[keyDef.key];
                    idList.forEach(function(id){
                        loadPromises.push(loadFromCache(keyDef.type, id).then(function(data){
                            d[keyDef.key].push(data);
                        }));
                    });
                    d[keyDef.key] = [];
                    d[keyDef.key].idList = idList;
                } else {
                    var id = d[keyDef.key];
                    loadPromises.push(loadFromCache(keyDef.type, id).then(function(data){
                        d[keyDef.key] = data;
                    }));
                }
            });
        });

        // ...and finally execute all promises and return our
        // fully loaded documents.
        return Promise.all(loadPromises).then(function() {
            return docs;
        });
    }

    getDefault(schemaProp) {
        if (schemaProp in this._schema && 'default' in this._schema[schemaProp]) {
            var def = this._schema[schemaProp].default;
            var defVal = typeof(def) === 'function' ? def() : def;
            return defVal;
        } else if (schemaProp === '_id') {
            return null;
        }

        return undefined;
    }

    toJSON(){
        var values = _.extend({}, this._values);
        var schema = this._schema;
        for(var key in schema){
            if(schema.hasOwnProperty(key)){
                if(schema[key].private){
                    delete values[key];
                } else if(typeof values[key] === "undefined") {
                    if (schema[key] instanceof Array || schema[key].type instanceof Array) {
                        values[key] = [];
                    } else {
                        values[key] = null;
                    }
                }
            }
        }
        var proto = Object.getPrototypeOf(this);
        var protoProps = Object.getOwnPropertyNames(proto);
        for(var i=0; i<protoProps.length; i++){
            key = protoProps[i];
            if(key !== 'constructor' && key !== 'id'){
                values[key] = this[key];
            }
        }
        return values;
    }
}

module.exports = BaseDocument;