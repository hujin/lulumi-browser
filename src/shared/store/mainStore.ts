import Vue from 'vue';
import Vuex from 'vuex';
import { BrowserWindow, ipcMain } from 'electron';
import { readFileSync } from 'fs';

import { actions } from './actions';
import { getters } from './getters';
import modules from './modules';

import urlResource from '../../renderer/js/lib/url-resource';

import { store } from 'lulumi';

Vue.use(Vuex);

/* tslint:disable:max-line-length */
/* tslint:disable:no-console */

const windows: Electron.BrowserWindow[] = [];

let close: boolean = false;

const broadcastMutations = (store) => {
  store.subscribe((mutation) => {
    Object.keys(windows).forEach((key) => {
      const id = parseInt(key, 10);
      if (typeof windows[id] !== 'number') {
        windows[id].webContents.send('vuex-apply-mutation', mutation);
      } else {
        delete windows[id];
      }
    });
  });
};

const store = new Vuex.Store({
  actions,
  getters,
  modules,
  plugins: [broadcastMutations],
  strict: process.env.NODE_ENV !== 'production',
});

const register = (storagePath: string, swipeGesture: boolean): void => {
  ipcMain.on('vuex-connect', (event: Electron.Event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window.setMaxListeners(0);

    window.on('scroll-touch-begin', () => {
      window.webContents.send('scroll-touch-begin', swipeGesture);
    });

    window.on('scroll-touch-end', () => {
      window.webContents.send('scroll-touch-end');
    });

    window.on('scroll-touch-edge', () => {
      window.webContents.send('scroll-touch-edge');
    });

    window.on('blur', () => {
      window.webContents.send('window-id', window.id);
    });

    window.on('close', (event: Electron.Event) => {
      if (close) {
        close = false;
      } else {
        ipcMain.once(('window-close' as any), () => {
          delete windows[window.id];
          window.webContents.removeAllListeners('scroll-touch-begin');
          window.webContents.removeAllListeners('scroll-touch-end');
          window.webContents.removeAllListeners('scroll-touch-edge');
          close = true;
          window.close();
        });
        window.webContents.send('window-close');
        event.preventDefault();
      }
    });

    windows[window.id] = window;
    event.returnValue = store.state;
  });

  ipcMain.on('vuex-action', (event, action) => {
    const type: string = action.type;
    store.dispatch(type, ...action.payload);
  });

  new Promise((resolve, reject) => {
    let data: string = '""';
    try {
      data = readFileSync(storagePath, 'utf8');
    } catch (event) { }

    try {
      data = JSON.parse(data);
      resolve(data);
    } catch (event) {
      reject();
      console.error(`could not parse data from ${storagePath}, ${event}`);
    }
  }).then((state) => {
    if (state) {
      store.dispatch('setAppState', state);
    }
  }).catch(() => console.error(`Failed to load appState from ${storagePath}!`));
};

const tabsMapping = (pages: store.PageObject[], tabsOrder: number[]): number[] => {
  const newOrder: number[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    if (tabsOrder) {
      newOrder[index] = tabsOrder.indexOf(index) === -1
        ? index
        : tabsOrder.indexOf(index);
    } else {
      newOrder[index] = index;
    }
  }
  return newOrder;
};

function tabsOrdering(newStart: number, bumpWindowIdsBy: number): store.PageObject[] {
  let newPid: number = newStart;
  let newPages: store.PageObject[] = [];
  let windowId: number = bumpWindowIdsBy === 0
    ? (1 + bumpWindowIdsBy)
    : (parseInt(Object.keys(windows)[0], 10) + bumpWindowIdsBy);
  Object.keys(windows).forEach((key) => {
    const tmpPages: store.PageObject[] = [];
    const id = parseInt(key, 10);
    const oldPages: store.PageObject[]
      = store.getters.pages.filter(page => page.windowId === id);
    const tabsOrder: number[] = tabsMapping(oldPages, store.getters.tabsOrder[id]);
    if (tabsOrder.length < oldPages.length) {
      for (let index = 0; index < oldPages.length; index += 1) {
        tmpPages.push((Object.assign({}, oldPages[index]) as any));
      }
    } else {
      oldPages.forEach((page, index) => {
        tmpPages.push((Object.assign({}, oldPages[tabsOrder[index]]) as any));
      });
    }
    tmpPages.forEach((page) => {
      page.pid = (newPid += 1);
      page.windowId = windowId;
      if (page.location.startsWith('about:')) {
        page.location = urlResource.aboutUrls(page.location);
      }
      if (page.location.startsWith('lulumi-extension:')) {
        page.location = urlResource.aboutUrls('about:newtab');
      }
    });
    newPages = newPages.concat(tmpPages);
    windowId += 1;
  });
  return newPages;
}

function tabIndexesOrdering(bumpWindowIdsBy: number): number[] {
  const newCurrentTabIndexes: number[] = [];
  let windowId: number = bumpWindowIdsBy === 0
    ? (1 + bumpWindowIdsBy)
    : (parseInt(Object.keys(windows)[0], 10) + bumpWindowIdsBy);
  Object.keys(windows).forEach((key) => {
    const id = parseInt(key, 10);
    const pages: store.PageObject[]
      = store.getters.pages.filter(page => page.windowId === id);
    const tabsOrder: number[] = tabsMapping(pages, store.getters.tabsOrder[id]);
    const currentTabIndex: number = store.getters.currentTabIndexes[id];
    newCurrentTabIndexes[windowId] = tabsOrder.indexOf(currentTabIndex) === -1
      ? currentTabIndex
      : tabsOrder.indexOf(currentTabIndex);
    windowId += 1;
  });
  return newCurrentTabIndexes;
}

function collect(getters, newStart: number, newPages: store.PageObject[], newCurrentTabIndexes: number[], downloads) {
  return {
    pid: newStart + newPages.length,
    pages: newPages,
    currentTabIndexes: newCurrentTabIndexes,
    currentSearchEngine: getters.currentSearchEngine,
    homepage: getters.homepage,
    pdfViewer: getters.pdfViewer,
    tabConfig: getters.tabConfig,
    lang: getters.lang,
    downloads: downloads.filter(download => download.state !== 'progressing'),
    history: getters.history,
  };
}

function saveAppState(soft: boolean = true, bumpWindowIdsBy: number = 0): Promise<any> {
  const newStart = Math.ceil(Math.random() * 10000);
  const newPages = tabsOrdering(newStart, bumpWindowIdsBy);
  const newCurrentTabIndexes = tabIndexesOrdering(bumpWindowIdsBy);
  const downloads = store.getters.downloads;
  const pendingDownloads = downloads.filter(download => download.state === 'progressing');

  if (soft) {
    return Promise.resolve(JSON.stringify(
      collect(store.getters, newStart, newPages, newCurrentTabIndexes, downloads)));
  }
  if (pendingDownloads.length !== 0) {
    ipcMain.once('okay-to-quit', (event, okay) => {
      if (okay) {
        return Promise.resolve(JSON.stringify(
          collect(store.getters, newStart, newPages, newCurrentTabIndexes, this.$store.getters.downloads)));
      }
      return Promise.resolve('');
    });
    BrowserWindow.getFocusedWindow().webContents.send('about-to-quit');
  }
  return Promise.resolve(JSON.stringify(
    collect(store.getters, newStart, newPages, newCurrentTabIndexes, downloads)));
}

function bumpWindowIds(bumpWindowIdsBy: number) {
  saveAppState(true, bumpWindowIdsBy).then((state) => {
    if (state) {
      store.dispatch('setAppState', JSON.parse(state));
    }
  });
}

export default {
  register,
  saveAppState,
  bumpWindowIds,
  getWindows: () => windows,
};