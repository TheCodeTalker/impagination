import Page from './page';

// Unrequested Pages do not show up in Pages Interface
export default class Store {
  constructor(previous = {}, attrs = {}) {
    Object.assign(this, {
      _pages: [],
      _unfetchablePages: [],
      length: 0,
      pageSize: 0,
      loadHorizon: previous.pageSize || 0,
      unloadHorizon: Infinity,
      readOffset: undefined,
      stats: { totalPages: undefined },

      // Consider a Records-Interface in the future
      // Right now is too early to abstract into class
      records: {}
    }, previous, attrs);

    if (!this.pageSize) {
      throw new Error('created Pages without pageSize');
    }

    if (this.unloadHorizon < this.loadHorizon) {
      throw new Error('created Pages with unloadHorizon less than loadHorizon');
    }

    this.totalPages = this.getPagesLength();

    this._updateHorizons();

    this.length = this._calcRecordsLength();
  }

  // fetchable
  get unrequested() {
    return this._pages.filter((page) => {
      return !page.isRequested;
    });
  }

  // fetchable
  get unfetchable() {
    return this._unfetchablePages;
  }

  // fetching
  get pending() {
    return this._pages.filter((page) => {
      return page.isPending;
    });
  }

  // fetched
  get resolved() {
    return this._pages.filter((page) => {
      return page.isResolved;
    });
  }

  // fetched
  get rejected() {
    return this._pages.filter((page) => {
      return page.isRejected;
    });
  }

  get requested() {
    return this._pages.filter((page) => {
      return page.isRequested;
    });
  }

  get unloaded() {
    return [];
  }

  setReadOffset(readOffset) {
    return new Store(this, { readOffset });
  }

  fetch(page = {}) {
    return new Store(this, {
      _pages: this._pages.map(p => p === page ? p.request() : p)
    });
  }

  unfetch(page = {}) {
    return new Store(this, {
      _unfetchablePages: this._unfetchablePages.filter(p => p !== page)
    });
  }

  resolve(records, page, stats) {
    return new Store(this, {
      _pages: this._pages.map(p => p === page ? p.resolve(records) : p),
      stats: stats || this.stats
    });
  }

  reject(error, page, stats) {
    return new Store(this, {
      _pages: this._pages.map(p => p === page ? p.reject(error) : p),
      stats: stats || this.stats
    });
  }

  // Private API
  getPagesLength() {
    let offset = this.readOffset;

    if (offset === null || offset === undefined) return 0;

    const baseOffset = this._pages[0] && this._pages[0].offset || 0;

    let maxLoadPage = Math.ceil((offset + this.loadHorizon) / this.pageSize);
    let maxUnloadPage = Math.ceil((offset + this.unloadHorizon) / this.pageSize);
    let maxLoadHorizon = Math.min(this.stats.totalPages || Infinity, maxLoadPage);
    let maxUnloadHorizon = Math.min(this.stats.totalPages || Infinity, maxUnloadPage, this.totalPages);

    return Math.max(this._pages.length + baseOffset, maxLoadHorizon, this.stats.totalPages || 0);
  }

  _calcRecordsLength() {
    return this.resolved.reduce((length, page) => {
      return length - (this.pageSize - page.records.length);
    }, (this.totalPages - this.rejected.length) * this.pageSize);
  }

  get(pageOffset) {
    const firstPage = this._pages[0];
    const lastPage = this._pages[this._pages.length - 1];

    const pageExists = this._pages.length &&
            pageOffset >= firstPage.offset &&
            pageOffset <= lastPage.offset;

    if (pageExists) {
      return this._pages[pageOffset - firstPage.offset];
    } else {
      return new Page(pageOffset, this.pageSize);
    }
  }

  getRecord(index) {
    if(index >= this.records.length) return null;

    const pageIndex = Math.floor(index / this.pageSize);
    const firstResolvedPage = this.resolved && this.resolved[0];

    const recordIsUnresolved = !firstResolvedPage || pageIndex < firstResolvedPage.offset;

    if (recordIsUnresolved) {
      const currentPage = this.get(pageIndex);
      const recordIndex = index % this.pageSize;

      return currentPage.records[recordIndex];
    } else {
      let currentPage = firstResolvedPage;
      let recordIndex = index - (currentPage.offset * this.pageSize);

      while(recordIndex >= currentPage.records.length) {
        recordIndex -= currentPage.records.length;
        currentPage = this.get(currentPage.offset + 1);
      }


      return currentPage.records[recordIndex];
    }
  }

  _updateHorizons() {
    this._unloadHorizons();
    this._requestHorizons();
  }

  _unloadHorizons() {
    let pages = this._pages;
    const baseOffset = pages[0] && pages[0].offset || 0;

    let minLoadPage = Math.floor((this.readOffset  - this.loadHorizon) / this.pageSize);
    let maxLoadPage = Math.ceil((this.readOffset  + this.loadHorizon) / this.pageSize);
    let minLoadHorizon = Math.max(minLoadPage, 0);
    let maxLoadHorizon = Math.min(this.stats.totalPages || Infinity, maxLoadPage);

    let minUnloadPage = Math.floor((this.readOffset - this.unloadHorizon) / this.pageSize) - baseOffset;
    let maxUnloadPage = Math.ceil((this.readOffset  + this.unloadHorizon) / this.pageSize) - baseOffset;
    let minUnloadHorizon = Math.max(minUnloadPage, 0) - baseOffset;
    let maxUnloadHorizon = Math.min(this.stats.totalPages || Infinity, maxUnloadPage, this._pages.length) - baseOffset;

    let unfetchable = [];
    // Unload Pages outside the upper `unloadHorizons`
    for (let i = pages.length - 1; i >= maxUnloadHorizon; i -= 1) {
      let page = pages[i];
      if (page) {
        let [ unloadedPage = {} ] = pages.splice(page.offset, 1);
        if (unloadedPage.isResolved) {
          unfetchable.push(unloadedPage);
        }
      }
    }

    // Unload Unrequested Pages outside the upper `loadHorizons`
    for (let i = maxUnloadHorizon - 1; i >= maxLoadHorizon; i -= 1) {
      let page = pages[i];
      if (page && !page.isSettled) {
        pages.splice(page.offset, 1);
      }
    }

    // Unload Unrequested Pages outside the lower `loadHorizons`
    for (let i = minLoadHorizon - 1; i >= minUnloadHorizon; i -= 1) {
      let page = pages[i];
      if (page && !page.isSettled) {
        pages.splice(page.offset, 1);
      }
    }

    // Unload Pages outside the lower `unloadHorizons`
    for (let i = minUnloadHorizon - 1; i >= 0; i -= 1) {
      let page = pages[i];
      if (page) {
        let [ unloadedPage = {} ] = pages.splice(page.offset, 1);
        if (unloadedPage.isResolved) {
          unfetchable.push(unloadedPage);
        }
      }
    }

    this._unfetchablePages = this._unfetchablePages.concat(unfetchable);
  }

  _requestHorizons() {
    let pages = this._pages;
    const baseOffset = pages[0] && pages[0].offset || 0;

    let minLoadPage = Math.floor((this.readOffset  - this.loadHorizon) / this.pageSize);
    let maxLoadPage = Math.ceil((this.readOffset  + this.loadHorizon) / this.pageSize);
    let minLoadHorizon = Math.max(minLoadPage, 0);
    let maxLoadHorizon = Math.min(this.stats.totalPages || Infinity, maxLoadPage);

    // Request and Fetch Records within the `loadHorizons`
    for (let i = minLoadHorizon; i < maxLoadHorizon; i += 1) {
      if (!pages[i]) {
        let unrequested = new Page(i + baseOffset, this.pageSize);
        pages.splice(unrequested.offset, 1, unrequested);
      }
    }
  }
}
