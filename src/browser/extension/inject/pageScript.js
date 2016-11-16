import { getActionsArray, evalAction } from 'remotedev-utils';
import createStore from '../../../app/stores/createStore';
import configureStore, { getUrlParam } from '../../../app/stores/enhancerStore';
import { isAllowed } from '../options/syncOptions';
import Monitor from '../../../app/service/Monitor';
import { getLocalFilter, isFiltered, filterState, startingFrom } from '../../../app/api/filters';
import notifyErrors from '../../../app/api/notifyErrors';
import importState from '../../../app/api/importState';
import openWindow from '../../../app/api/openWindow';
import {
  updateStore, toContentScript, sendMessage, setListener, connect, disconnect,
  generateId, isInIframe
} from '../../../app/api';

const source = '@devtools-page';
let stores = {};
let reportId;

function deprecateParam(oldParam, newParam) {
  /* eslint-disable no-console */
  console.warn(`${oldParam} parameter is deprecated, use ${newParam} instead: https://github.com/zalmoxisus/redux-devtools-extension/blob/master/docs/API/Arguments.md`);
  /* eslint-enable no-console */
}

const devToolsExtension = function(reducer, preloadedState, config) {
  /* eslint-disable no-param-reassign */
  if (typeof reducer === 'object') {
    config = reducer; reducer = undefined;
  } else if (typeof config !== 'object') config = {};
  /* eslint-enable no-param-reassign */
  if (!window.devToolsOptions) window.devToolsOptions = {};

  let store;
  let errorOccurred = false;
  let sendingActionTimeout;
  let sendingStateTimeout;
  let sendingActionId;
  let maxAge;
  let actionCreators;
  let shouldSerialize;
  let serializeState;
  let serializeAction;
  const instanceId = generateId(config.instanceId);
  const localFilter = getLocalFilter(config);
  const latency = config.latency || 500;
  let { statesFilter, actionsFilter, stateSanitizer, actionSanitizer, predicate } = config;

  // Deprecate statesFilter and actionsFilter
  if (statesFilter) {
    deprecateParam('statesFilter', 'stateSanitizer');
    stateSanitizer = statesFilter; // eslint-disable-line no-param-reassign
  }
  if (actionsFilter) {
    deprecateParam('actionsFilter', 'actionSanitizer');
    actionSanitizer = actionsFilter; // eslint-disable-line no-param-reassign
  }

  if (typeof config.serializeState !== 'undefined') {
    serializeState = config.serializeState;
    if (typeof serializeState === 'function') serializeState = { replacer: serializeState };
    else shouldSerialize = true;
  }
  if (typeof config.serializeAction !== 'undefined') {
    serializeAction = config.serializeAction;
    if (typeof serializeAction === 'function') serializeAction = { replacer: serializeAction };
    else shouldSerialize = true;
  }

  const monitor = new Monitor(relayState);
  if (config.getMonitor) config.getMonitor(monitor);

  function exportState() {
    const liftedState = store.liftedStore.getState();
    const actionsById = liftedState.actionsById;
    const payload = [];
    liftedState.stagedActionIds.slice(1).forEach(id => {
      // if (isFiltered(actionsById[id].action, localFilter)) return;
      payload.push(actionsById[id].action);
    });
    toContentScript({
      type: 'EXPORT', payload, committedState: liftedState.committedState, source, instanceId
    }, serializeState, serializeAction, shouldSerialize);
  }

  function relay(type, state, action, nextActionId, shouldInit) {
    const message = {
      type,
      payload: filterState(
        state, type, localFilter, stateSanitizer, actionSanitizer, nextActionId, predicate
      ),
      source,
      instanceId
    };

    if (type === 'ACTION') {
      message.action = !actionSanitizer ? action : actionSanitizer(action.action, nextActionId - 1);
      message.maxAge = maxAge;
      message.nextActionId = nextActionId;
    } else if (shouldInit) {
      message.action = action;
      message.name = config.name || document.title;
    }

    toContentScript(message, serializeState, serializeAction, shouldSerialize);
  }

  function relayState(actions, shouldInit) {
    relay('STATE', store.liftedStore.getState(), actions, undefined, shouldInit);
  }

  function relayPendingAction() {
    sendingActionTimeout = undefined;
    const liftedState = store.liftedStore.getState();
    const nextActionId = liftedState.nextActionId;
    const state = liftedState.computedStates[liftedState.computedStates.length - 1].state;
    relay('ACTION', state, liftedState.actionsById[nextActionId - 1], nextActionId);
  }

  function relayPendingActions() {
    sendingStateTimeout = undefined;
    sendingActionTimeout = undefined;

    if (sendingActionId === undefined) {
      relayState(); return;
    }

    const liftedState = store.liftedStore.getState();
    const payload = startingFrom(
      sendingActionId,
      liftedState,
      localFilter, stateSanitizer, actionSanitizer, predicate
    );
    sendingActionId = undefined;
    if (typeof payload === 'undefined') return;
    if (typeof payload.skippedActionIds !== 'undefined') {
      relay('STATE', payload);
      return;
    }
    toContentScript({
      type: 'PARTIAL_STATE',
      payload,
      source,
      instanceId,
      maxAge
    }, serializeState, serializeAction, shouldSerialize);
  }

  function dispatchRemotely(action) {
    try {
      const result = evalAction(action, actionCreators);
      (store.initialDispatch || store.dispatch)(result);
    } catch (e) {
      relay('ERROR', e.message);
    }
  }

  function importPayloadFrom(state) {
    try {
      const nextLiftedState = importState(state, config);
      if (!nextLiftedState) return;
      store.liftedStore.dispatch({type: 'IMPORT_STATE', ...nextLiftedState});
      relayState();
    } catch (e) {
      relay('ERROR', e.message);
    }
  }

  function onMessage(message) {
    switch (message.type) {
      case 'DISPATCH':
        store.liftedStore.dispatch(message.payload);
        return;
      case 'ACTION':
        dispatchRemotely(message.payload);
        return;
      case 'IMPORT':
        importPayloadFrom(message.state);
        return;
      case 'EXPORT':
        exportState();
        return;
      case 'UPDATE':
        relayState();
        return;
      case 'START':
        monitor.start(true);
        if (!actionCreators && config.actionCreators) {
          actionCreators = getActionsArray(config.actionCreators);
        }
        relayState(JSON.stringify(actionCreators), true);

        if (reportId) {
          relay('GET_REPORT', reportId);
          reportId = null;
        }
        return;
      case 'STOP':
        monitor.stop();
        clearTimeout(sendingActionTimeout);
        clearTimeout(sendingStateTimeout);
        sendingStateTimeout = undefined;
        sendingActionTimeout = undefined;
        if (!message.failed) relay('STOP');
    }
  }

  function init() {
    maxAge = config.maxAge || window.devToolsOptions.maxAge || 50;

    setListener(onMessage, instanceId);
    notifyErrors(() => {
      errorOccurred = true;
      const state = store.liftedStore.getState();
      if (state.computedStates[state.currentStateIndex].error) {
        relay('STATE', state);
      }
      return true;
    });

    relay('INIT_INSTANCE');
    store.subscribe(handleChange);

    if (typeof reportId === 'undefined') {
      reportId = getUrlParam('remotedev_report');
      if (reportId) openWindow();
    }
  }

  function handleChange() {
    if (!monitor.active || sendingStateTimeout) return;
    if (!errorOccurred && !monitor.isMonitorAction()) {
      const liftedState = store.liftedStore.getState();
      const nextActionId = liftedState.nextActionId;
      const currentActionId = nextActionId - 1;
      const liftedAction = liftedState.actionsById[currentActionId];
      const action = liftedAction.action;
      if (isFiltered(action, localFilter)) return;
      if (
        predicate &&
        !predicate(liftedState.computedStates[liftedState.computedStates.length - 1].state, action)
      ) return;
      if (sendingActionTimeout) {
        clearTimeout(sendingActionTimeout);
        sendingStateTimeout = setTimeout(relayPendingActions, latency);
        return;
      }
      sendingActionTimeout = setTimeout(relayPendingAction, latency);
      sendingActionId = currentActionId;
    } else {
      if (monitor.isPaused() || monitor.isLocked() || monitor.isTimeTraveling()) return;
      if (sendingStateTimeout) {
        clearTimeout(sendingStateTimeout);
        sendingStateTimeout = undefined;
        sendingActionTimeout = undefined;
      } else if (sendingActionTimeout) {
        clearTimeout(sendingActionTimeout);
        sendingActionTimeout = undefined;
      }
      const liftedState = store.liftedStore.getState();
      if (errorOccurred && !liftedState.computedStates[liftedState.currentStateIndex].error) {
        errorOccurred = false;
      }
      relay('STATE', liftedState);
    }
  }

  const enhance = () => (next) => {
    return (reducer_, initialState_, enhancer_) => {
      if (!isAllowed(window.devToolsOptions)) return next(reducer_, initialState_, enhancer_);

      store = stores[instanceId] =
        configureStore(next, monitor.reducer, config)(reducer_, initialState_, enhancer_);

      if (isInIframe()) setTimeout(init, 3000);
      else init();

      return store;
    };
  };

  if (!reducer) return enhance();
  return createStore(reducer, preloadedState, enhance);
};

// noinspection JSAnnotator
window.devToolsExtension = devToolsExtension;
window.devToolsExtension.open = openWindow;
window.devToolsExtension.updateStore = updateStore(stores);
window.devToolsExtension.notifyErrors = notifyErrors;
window.devToolsExtension.send = sendMessage;
window.devToolsExtension.listen = setListener;
window.devToolsExtension.connect = connect;
window.devToolsExtension.disconnect = disconnect;

window.__REDUX_DEVTOOLS_EXTENSION__ = window.devToolsExtension;

const preEnhancer = instanceId => next =>
  (reducer, preloadedState, enhancer) => {
    const store = next(reducer, preloadedState, enhancer);

    // Mutate the store in order to keep the reference
    if (stores[instanceId]) {
      stores[instanceId].initialDispatch = store.dispatch;
      stores[instanceId].liftedStore = store.liftedStore;
      stores[instanceId].getState = store.getState;
    }

    return {
      ...store,
      dispatch: (action) => (
        window.__REDUX_DEVTOOLS_EXTENSION_LOCKED__ ? action : store.dispatch(action)
      )
    };
  };

const extensionCompose = (config) => (...funcs) => {
  return (...args) => {
    const instanceId = generateId(config.instanceId);
    return [preEnhancer(instanceId), ...funcs].reduceRight(
      (composed, f) => f(composed), devToolsExtension({ ...config, instanceId })(...args)
    );
  };
};

window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ = (...funcs) => {
  if (funcs.length === 0) {
    return devToolsExtension();
  }
  if (funcs.length === 1 && typeof funcs[0] === 'object') {
    return extensionCompose(funcs[0]);
  }
  return extensionCompose({})(...funcs);
};
