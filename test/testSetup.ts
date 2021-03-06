/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';

import {DebugProtocol} from 'vscode-debugprotocol';
import {DebugClient} from 'vscode-debugadapter-testsupport';

// ES6 default export...
const LoggingReporter = require('./loggingReporter');

const NIGHTLY_NAME = os.platform() === 'win32' ? 'node-nightly.cmd' : 'node-nightly';
const DEBUG_ADAPTER = './out/src/nodeDebug.js';

let dc: DebugClient;

let unhandledAdapterErrors: string[];
const origTest = test;
const checkLogTest = (expectation: string, assertion?: any, testFn: Function = origTest): Mocha.ITest => {
    // Hack to always check logs after a test runs, can simplify after this issue:
    // https://github.com/mochajs/mocha/issues/1635
    if (!assertion) {
        return origTest(expectation, assertion);
    }

    function runTest(): Promise<any> {
        return new Promise((resolve, reject) => {
            const maybeP = assertion(resolve);
            if (maybeP && maybeP.then) {
                maybeP.then(resolve, reject);
            }
        });
    }

    return testFn(expectation, done => {
        runTest()
            .then(() => {
                // If any unhandled errors were logged, then ensure the test fails
                if (unhandledAdapterErrors.length) {
                    const errStr = unhandledAdapterErrors.length === 1 ? unhandledAdapterErrors[0] :
                        JSON.stringify(unhandledAdapterErrors);
                    throw new Error(errStr);
                }
            })
            .then(done, done)
    });
};
(<Mocha.ITestDefinition>checkLogTest).only = (expectation, assertion) => checkLogTest(expectation, assertion, origTest.only);
(<Mocha.ITestDefinition>checkLogTest).skip = test.skip;
test = (<any>checkLogTest);

function log(e: DebugProtocol.OutputEvent) {
    // Skip telemetry events
    if (e.body.category === 'telemetry') return;

    const timestamp = new Date().toISOString().split(/[TZ]/)[1];
    const outputBody = e.body.output ? e.body.output.trim() : 'variablesReference: ' + e.body.variablesReference;
    const msg = ` ${timestamp} ${outputBody}`;
    LoggingReporter.logEE.emit('log', msg);

    if (msg.indexOf('********') >= 0) unhandledAdapterErrors.push(msg);
};

function patchLaunchArgs(): void {
    const origLaunch = dc.launch;
    dc.launch = (launchArgs: any) => {
        launchArgs.verboseDiagnosticLogging = true;
        if (process.version.startsWith('v6.2')) {
            launchArgs.runtimeExecutable = NIGHTLY_NAME;
        }

        return origLaunch.call(dc, launchArgs);
    };

    const origHitBreakpoint = dc.hitBreakpoint;
    dc.hitBreakpoint = (...args) => {
        const launchArgs = args[0];
        launchArgs.verboseDiagnosticLogging = true;
        if (process.version.startsWith('v6.2')) {
            launchArgs.runtimeExecutable = NIGHTLY_NAME;
        }

        return origHitBreakpoint.apply(dc, args);
    };
}

export const lowercaseDriveLetterDirname = __dirname.charAt(0).toLowerCase() + __dirname.substr(1);
export const PROJECT_ROOT = path.join(lowercaseDriveLetterDirname, '../../');
export const DATA_ROOT = path.join(PROJECT_ROOT, 'testdata/');

export function setup(port?: number) {
    unhandledAdapterErrors = [];
    dc = new DebugClient('node', DEBUG_ADAPTER, 'node2');
    patchLaunchArgs();
    dc.addListener('output', log);

    return dc.start(port)
        .then(() => dc);
}

export function teardown() {
    dc.removeListener('output', log);
    return dc.stop();
}