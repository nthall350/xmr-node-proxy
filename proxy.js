"use strict";
const cluster = require('cluster');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const async = require('async');
const uuidV4 = require('uuid/v4');
const support = require('./lib/support.js');
global.config = require('./config.json');

/*
 General file design/where to find things.

 Internal Variables
 IPC Registry
 Combined Functions
 Master Functions
 Miner Definition
 Slave Functions
 API Calls (Master-Only)
 System Init

 */
let debug = {
    pool: require('debug')('pool'),
    diff: require('debug')('diff'),
    blocks: require('debug')('blocks'),
    shares: require('debug')('shares'),
    miners: require('debug')('miners')
};
global.threadName = '';
let pastBlockTemplates = {};
let nonceCheck = new RegExp("^[0-9a-f]{8}$");
let activePorts = [];
let httpResponse = ' 200 OK\nContent-Type: text/plain\nContent-Length: 18\n\nMining Proxy Online';
let activeMiners = {};
let bans = {};
let activePools = {};

// IPC Registry
function masterMessageHandler(worker, message, handle) {
    switch (message.type) {
    }
}

function slaveMessageHandler(message) {
    switch (message.type) {
        case 'newBlockTemplate':
            if (message.host in activePools){
                activePools[message.host].activeBlocktemplate = activePools[message.host].coinFuncs.blockTemplate(message.data);
            }
    }
}

// Combined Functions
function readConfig() {
    let local_conf = JSON.parse(fs.readFileSync('config.json'));
    if (typeof global.config === 'undefined') {
        global.config = {};
    }
    for (let key in local_conf) {
        if (local_conf.hasOwnProperty(key) && (typeof global.config[key] === 'undefined' || global.config[key] !== local_conf[key])) {
            global.config[key] = local_conf[key];
        }
    }
    if (!cluster.isMaster) {
        activatePorts();
    }
}

// Master Functions

// Miner Definition
function Miner(id, params, ip, pushMessage, portData) {
    // Arguments
    // minerId, params, ip, pushMessage, portData
    // Username Layout - <address in BTC or XMR>.<Difficulty>
    // Password Layout - <password>.<miner identifier>.<payment ID for XMR>
    // Default function is to use the password so they can login.  Identifiers can be unique, payment ID is last.
    // If there is no miner identifier, then the miner identifier is set to the password
    // If the password is x, aka, old-logins, we're not going to allow detailed review of miners.

    // Miner Variables
    this.coin = portData.coin;
    this.coinFuncs = require(`./lib/${portData.coin}.js`);
    let coinSettings = global.config.coinSettings[portData.coin];
    this.login = params.login;  // Documentation purposes only.
    this.password = params.pass;  // Documentation purposes only.
    this.agent = params.agent;  // Documentation purposes only.
    this.ip = ip;  // Documentation purposes only.
    this.messageSender = pushMessage;
    this.error = "";
    this.valid_miner = true;
    this.incremented = false;
    let diffSplit = this.login.split("+");
    this.fixed_diff = false;
    this.difficulty = portData.diff;
    this.connectTime = Date.now();
    if (!(portData.coin in activePools)){
        this.error = "No active pool for the requested coin";
        this.valid_miner = false;
    }
    for (let pool in activePools[portData.coin]){
        if (activePools[portData.coin].hasOwnProperty(pool)){
            this.pool = pool.hostname;
            break;
        }
    }

    if (diffSplit.length === 2) {
        this.fixed_diff = true;
        this.difficulty = Number(diffSplit[1]);
    } else if (diffSplit.length > 2) {
        this.error = "Too many options in the login field";
        this.valid_miner = false;
    }

    if (!(activePools[this.coin][this.pool].hasOwnProperty('activeBlockTemplate'))){
        this.error = "No active block template";
        this.valid_miner = false;
    }

    this.id = id;
    this.heartbeat = function () {
        this.lastContact = Date.now();
    };
    this.heartbeat();

    // VarDiff System
    this.shareTimeBuffer = support.circularBuffer(8);
    this.shareTimeBuffer.enq(coinSettings.shareTargetTime);
    this.lastShareTime = Date.now() / 1000 || 0;

    this.shares = 0;
    this.blocks = 0;
    this.hashes = 0;
    this.logString = this.id + " IP: " + this.ip;

    this.validJobs = global.support.circularBuffer(5);

    this.cachedJob = null;

    this.minerStats = function(){
        return {
            shares: this.shares,
            blocks: this.blocks,
            hashes: this.hashes,
            avgSpeed: Math.floor(this.hashes/(Math.floor((Date.now() - this.connectTime)/1000))),
            diff: this.difficulty,
            lastContact: Math.floor(this.lastContact/1000),
            lastShare: this.lastShareTime,
            coin: this.coin,
            pool: this.pool,
            id: this.id
        };
    };

    this.activeBlocktemplate = function(){
        return activePools[this.coin][this.pool].activeBlocktemplate;
    };

    // Support functions for how miners activate and run.
    this.updateDifficulty = function(){
        if (this.hashes > 0 && !this.fixed_diff) {
            this.setNewDiff(Math.floor(this.hashes / (Math.floor((Date.now() - this.connectTime) / 1000))) * global.config.pool.targetTime);
        }
    };

    this.setNewDiff = function (difficulty) {
        this.newDiff = Math.round(difficulty);
        debug.diff(global.threadName + "Difficulty: " + this.newDiff + " For: " + this.logString + " Time Average: " + this.shareTimeBuffer.average(this.lastShareTime) + " Entries: " + this.shareTimeBuffer.size() + "  Sum: " + this.shareTimeBuffer.sum());
        if (this.newDiff > coinSettings.maxDiff) {
            this.newDiff = coinSettings.maxDiff;
        }
        if (this.newDiff < coinSettings.minDiff) {
            this.newDiff = coinSettings.minDiff;
        }
        if (this.difficulty === this.newDiff) {
            return;
        }
        debug.diff(global.threadName + "Difficulty change to: " + this.newDiff + " For: " + this.logString);
        if (this.hashes > 0){
            debug.diff(global.threadName + "Hashes: " + this.hashes + " in: " + Math.floor((Date.now() - this.connectTime)/1000) + " seconds gives: " +
                Math.floor(this.hashes/(Math.floor((Date.now() - this.connectTime)/1000))) + " hashes/second or: " +
                Math.floor(this.hashes/(Math.floor((Date.now() - this.connectTime)/1000))) *coinSettings.shareTargetTime + " difficulty versus: " + this.newDiff);
        }
        this.messageSender('job', this.getJob());
    };

    this.getTargetHex = this.coinFuncs.getTargetHex;
    this.getJob = this.coinFuncs.getJob;
}

// Slave Functions
function handleMinerData(method, params, ip, portData, sendReply, pushMessage) {
    /*
    Deals with handling the data from miners in a sane-ish fashion.
     */
    let miner = activeMiners[params.id];
    // Check for ban here, so preconnected attackers can't continue to screw you
    if (ip in bans) {
        // Handle IP ban off clip.
        sendReply("IP Address currently banned");
        return;
    }
    switch (method) {
        case 'login':
            let difficulty = portData.difficulty;
            let minerId = uuidV4();
            miner = new Miner(minerId, params, ip, pushMessage, portData);
            if (!miner.valid_miner) {
                console.log("Invalid miner, disconnecting due to: " + miner.error);
                sendReply(miner.error);
                return;
            }
            process.send({type: 'newMiner', data: miner.port});
            activeMiners[minerId] = miner;
            sendReply(null, {
                id: minerId,
                job: miner.getJob(miner),
                status: 'OK'
            });
            break;
        case 'getjob':
            if (!miner) {
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            sendReply(null, miner.getJob(miner));
            break;
        case 'submit':
            if (!miner) {
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();

            let job = miner.validJobs.toarray().filter(function (job) {
                return job.id === params.job_id;
            })[0];

            if (!job) {
                sendReply('Invalid job id');
                return;
            }

            params.nonce = params.nonce.substr(0, 8).toLowerCase();
            if (!nonceCheck.test(params.nonce)) {
                console.warn(global.threadName + 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + miner.logString);
                sendReply('Duplicate share');
                return;
            }

            if (job.submissions.indexOf(params.nonce) !== -1) {
                console.warn(global.threadName + 'Duplicate share: ' + JSON.stringify(params) + ' from ' + miner.logString);
                sendReply('Duplicate share');
                return;
            }

            job.submissions.push(params.nonce);
            let activeBlockTemplate = miner.activeBlocktemplate();
            let pastBlockTemplates = activeBlockTemplate.pastBlockTemplates;

            let blockTemplate = activeBlockTemplate.height === job.height ? activeBlockTemplate : pastBlockTemplates.toarray().filter(function (t) {
                return t.height === job.height;
            })[0];

            if (!blockTemplate) {
                console.warn(global.threadName + 'Block expired, Height: ' + job.height + ' from ' + miner.logString);
                if (miner.incremented === false){
                    miner.newDiff = miner.difficulty + 1;
                    miner.incremented = true;
                } else {
                    miner.newDiff = miner.difficulty - 1;
                    miner.incremented = false;
                }
                miner.messageSender('job', miner.getJob());
                sendReply('Block expired');
                return;
            }

            let shareAccepted = miner.coinFuncs.processShare(miner, job, blockTemplate, params.nonce, params.result);

            if (!shareAccepted) {
                sendReply('Low difficulty share');
                return;
            }

            let now = Date.now() / 1000 || 0;
            miner.shareTimeBuffer.enq(now - miner.lastShareTime);
            miner.lastShareTime = now;

            sendReply(null, {status: 'OK'});
            break;
        case 'keepalived':
            if (!miner) {
                sendReply('Unauthenticated');
                return;
            }
            sendReply(null, {
                status: 'KEEPALIVED'
            });
            break;
    }
}

function activatePorts() {
    /*
     Reads the current open ports, and then activates any that aren't active yet
     { "port": 80, "ssl": false, "diff": 5000 }
     and binds a listener to it.
     */
    async.each(global.config.listeningPorts, function (portData) {
        if (activePorts.indexOf(portData.port) !== -1) {
            return;
        }
        let handleMessage = function (socket, jsonData, pushMessage) {
            if (!jsonData.id) {
                console.warn('Miner RPC request missing RPC id');
                return;
            }
            else if (!jsonData.method) {
                console.warn('Miner RPC request missing RPC method');
                return;
            }
            else if (!jsonData.params) {
                console.warn('Miner RPC request missing RPC params');
                return;
            }

            let sendReply = function (error, result) {
                if (!socket.writable) {
                    return;
                }
                let sendData = JSON.stringify({
                        id: jsonData.id,
                        jsonrpc: "2.0",
                        error: error ? {code: -1, message: error} : null,
                        result: result
                    }) + "\n";
                socket.write(sendData);
            };
            handleMinerData(jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, pushMessage);
        };

        function socketConn(socket) {
            socket.setKeepAlive(true);
            socket.setEncoding('utf8');

            let dataBuffer = '';

            let pushMessage = function (method, params) {
                if (!socket.writable) {
                    return;
                }
                let sendData = JSON.stringify({
                        jsonrpc: "2.0",
                        method: method,
                        params: params
                    }) + "\n";
                socket.write(sendData);
            };

            socket.on('data', function (d) {
                dataBuffer += d;
                if (Buffer.byteLength(dataBuffer, 'utf8') > 10240) { //10KB
                    dataBuffer = null;
                    console.warn(global.threadName + 'Excessive packet size from: ' + socket.remoteAddress);
                    socket.destroy();
                    return;
                }
                if (dataBuffer.indexOf('\n') !== -1) {
                    let messages = dataBuffer.split('\n');
                    let incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                    for (let i = 0; i < messages.length; i++) {
                        let message = messages[i];
                        if (message.trim() === '') {
                            continue;
                        }
                        let jsonData;
                        try {
                            jsonData = JSON.parse(message);
                        }
                        catch (e) {
                            if (message.indexOf('GET /') === 0) {
                                if (message.indexOf('HTTP/1.1') !== -1) {
                                    socket.end('HTTP/1.1' + httpResponse);
                                    break;
                                }
                                else if (message.indexOf('HTTP/1.0') !== -1) {
                                    socket.end('HTTP/1.0' + httpResponse);
                                    break;
                                }
                            }
                            console.warn(global.threadName + "Malformed message from " + socket.remoteAddress + " Message: " + message);
                            socket.destroy();
                            break;
                        }
                        handleMessage(socket, jsonData, pushMessage);
                    }
                    dataBuffer = incomplete;
                }
            }).on('error', function (err) {
                if (err.code !== 'ECONNRESET') {
                    console.warn(global.threadName + "Socket Error from " + socket.remoteAddress + " " + err);
                }
            }).on('close', function () {
                pushMessage = function () {
                };
            });
        }

        if ('ssl' in portData && portData.ssl === true) {
            tls.createServer({
                key: fs.readFileSync('cert.key'),
                cert: fs.readFileSync('cert.pem')
            }, socketConn).listen(portData.port, global.config.bindAddress, function (error) {
                if (error) {
                    console.error(global.threadName + "Unable to start server on: " + portData.port + " Message: " + error);
                    return;
                }
                activePorts.push(portData.port);
                console.log(global.threadName + "Started server on port: " + portData.port);
            });
        } else {
            net.createServer(socketConn).listen(portData.port, global.config.bindAddress, function (error) {
                if (error) {
                    console.error(global.threadName + "Unable to start server on: " + portData.port + " Message: " + error);
                    return;
                }
                activePorts.push(portData.port);
                console.log(global.threadName + "Started server on port: " + portData.port);
            });
        }
    });
}

// API Calls

// System Init