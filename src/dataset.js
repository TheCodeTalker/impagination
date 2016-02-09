import Page from './page';
import Record from './record';

class State {
  constructor() {
    this.isPending = false;
    this.isRejected = false;
    this.isResolved = false;
    this.pages = [];
    this.stats = {
      totalPages: undefined
    };
    this.length = 0;
  }

  get isSettled()  { return !this.isPending && (this.isRejected || this.isResolved); }

  update(change) {
    let next = new State();
    next.isPending = this.isPending;
    next.isResolved = this.isResolved;
    next.isRejected = this.isRejected;
    next.length = this.length;
    next.pageSize = this.pageSize;
    next.loadHorizon = this.loadHorizon;
    next.unloadHorizon = this.unloadHorizon;
    next.readOffset = this.readOffset;
    next.pages = this.pages.slice();
    next.stats.totalPages = this.stats.totalPages;
    change.call(this, next);
    next.pages = Object.freeze(next.pages);
    return next;
  }

  get(index) {
    if(index >= this.length) {return null;}

    let offset = {
      // Compute Record and Page Offsets without page filtering
      pageIndex: Math.floor(index / this.pageSize),
      recordIndex: index % this.pageSize
    };

    // Dynamically find the page offset
    const minUnloadPage = Math.floor((this.readOffset - this.unloadHorizon) / this.pageSize);
    const minUnloadHorizon = Math.max(minUnloadPage, 0);

    if(offset.pageIndex >= minUnloadHorizon) {
      // Compute Record Offset with page filtering
      const maxUnloadPage = Math.ceil((this.readOffset  + this.unloadHorizon) / this.pageSize);
      const maxUnloadHorizon = Math.min(this.stats.totalPages || Infinity, maxUnloadPage, this.pages.length);
      const maxUnloadIndex = index - (minUnloadHorizon * this.pageSize);
      offset.recordIndex = maxUnloadIndex;

      const minUnloadPageOffset = this.pages.slice(minUnloadHorizon, maxUnloadHorizon).findIndex(function(page) {
        if(this.recordIndex < page.records.length) {
          return true;
        } else {
          this.recordIndex -= page.records.length;
          return false;
        }
        return this.recordIndex < page.records.length;
      }, offset);

      if(minUnloadPageOffset < 0 ){
        // page not found in Unload Horizons
        offset.pageIndex = Math.floor(offset.recordIndex / this.pageSize) + maxUnloadHorizon;
      } else {
        offset.pageIndex = minUnloadPageOffset + minUnloadHorizon;
      }
    }

    const page = this.pages[offset.pageIndex];
    return page && page.records[offset.recordIndex] || null;
  }
}

function isEmpty(hash){
  return Object.keys(hash).length === 0;
}

export default class Dataset {

  constructor(options = {}) {
    if (!options.pageSize) {
      throw new Error('created Dataset without pageSize');
    }
    if (!options.fetch) {
      throw new Error('created Dataset without fetch()');
    }

    this._pageSize = Number(options.pageSize);
    this._fetch = options.fetch;
    this._unfetch = options.unfetch || function() {};
    this._observe = options.observe || function() {};
    this._filter = options.filter || function() {return true;};
    this.state = new State();
    this.state.pageSize = Number(this._pageSize);
    this.state.loadHorizon = Number(options.loadHorizon || this._pageSize);
    this.state.unloadHorizon = Number(options.unloadHorizon) || Infinity;

    if (this.state.unloadHorizon < this.state.loadHorizon) {
      throw new Error('created Dataset with unloadHorizon less than loadHorizon');
    }
  }

  setReadOffset(readOffset, options = {}) {
    if (this.state.readOffset === readOffset && isEmpty(options)) {return;}
    this._validateOptions(options);
    this._initPageByOption = this._initPage(options);

    readOffset = (readOffset >= 0) ? readOffset : 0;
    let state = this.state.update((next)=> {
      next.readOffset = readOffset;
      next.pages = (!options.reset) ? next.pages : [];

      let minLoadPage = Math.floor((readOffset  - next.loadHorizon) / next.pageSize);
      let maxLoadPage = Math.ceil((readOffset  + next.loadHorizon) / next.pageSize);
      let minUnloadPage = Math.floor((readOffset - next.unloadHorizon) / next.pageSize);
      let maxUnloadPage = Math.ceil((readOffset  + next.unloadHorizon) / next.pageSize);

      var minLoadHorizon = Math.max(minLoadPage, 0);
      var maxLoadHorizon = Math.min(next.stats.totalPages || Infinity, maxLoadPage);
      var minUnloadHorizon = Math.max(minUnloadPage, 0);
      var maxUnloadHorizon = Math.min(next.stats.totalPages || Infinity, maxUnloadPage, next.pages.length);

      let pages  = next.pages;
      // Unload Pages outside the `unloadHorizons`
      for (i = 0; i < minUnloadHorizon; i += 1) {
        this._unloadPage(pages, i);
      }
      for (i = maxUnloadHorizon; i < pages.length; i += 1) {
        this._unloadPage(pages, i);
      }

      // Initialize Pages between current Horizons
      let currentMinHorizon = Math.min(minUnloadHorizon, minLoadHorizon);
      let currentMaxHorizon = Math.max(maxUnloadHorizon, maxLoadHorizon);
      for (var i = currentMinHorizon; i < currentMaxHorizon; i += 1) {
        this._initPageByOption.call(this, pages, i);
      }

      this._adjustTotalRecords(next);

      // Request and Fetch Records within the `loadHorizons`
      for (i = minLoadHorizon; i < maxLoadHorizon; i += 1) {
        let page = pages[i];

        if (!page.isRequested) {
          pages[i] = page.request();
          this._fetchPage(pages[i]);
        }
      }

      if (readOffset >= next.length) {
        console.warn(`Warning: Requested records at readOffset ${readOffset}. Maximum readOffset: ${next.length - 1}`);
      }
      this._setStateStatus(next);
    });
    this._observe(this.state = state);
  }

  refilter(readOffset){
    readOffset = (readOffset >= 0) ? readOffset : this.state.readOffset;
    this.setReadOffset(readOffset, {refilter: true});
  }

  reload(readOffset){
    readOffset = (readOffset >= 0) ? readOffset : 0;
    this.setReadOffset(readOffset, {reload: true});
  }

  reset(readOffset){
    readOffset = (readOffset >= 0) ? readOffset : 0;
    this.setReadOffset(readOffset, {reset: true});
  }

  _validateOptions(options){
    // A maximum of 1 option may be enabled at any given time
    if ((options.refilter && options.reload) ||
        (options.refilter && options.reset)  ||
        (options.reload  && options.reset)) {
      throw new Error('Error: set read offset with multiple options enabled: Only apply a signle option of refilter, reset, or reload');
    }
  }

  // Returns a function to be called on each page within the unloadHorizon
  _initPage(options){
    if(options.refilter){
      return this._filterPage;
    } else if(options.reload) {
      return this._unloadPage;
    } else {
      return this._touchPage;
    }
  }

  /* Unloads a page at the given index and returns the unloaded page */
  _unloadPage(pages, i) {
    let page = this._touchPage(pages, i);
    if (page.isRequested) {
      this._unfetch.call(this, page.data, page.offset);
      page = page.unload();
      pages.splice(i, 1, page);
    }
    return page;
  }

  /* Returns the page at the given index
   * If no page exists it generates and returns a new Page instance */
  _touchPage(pages, i) {
    var page = pages[i];
    if(!page) {
      page = new Page(i, this._pageSize);
      pages.splice(i, 1, page);
    }
    return page;
  }

  /* Returns the page at the given index
   * If the page is a resolved page, it reruns the filters
   * and returns a new ResolvedPage instance */
  _filterPage(pages, i) {
    let page = this._touchPage(pages, i);
    if(page.isResolved) {
      page = page.resolve(page.unfilteredData, page.filterCallback);
      pages.splice(i, 1, page);
    }
    return page;
  }

  _adjustTotalPages(pages, stats) {
    if(stats.totalPages > pages.length) {
      // touch pages
      for (let i = pages.length; i < stats.totalPages; i += 1) {
        this._touchPage(pages, i);
      }
    } else if(stats.totalPages < pages.length) {
      // remove pages
      pages.splice(stats.totalPages, pages.length);
    }
  }

  _adjustTotalRecords(state) {
    state.length = state.pages.reduce((length, page) => {
      return length + page.data.length;
    }, 0);
  }

  _setStateStatus(state) {
    state.isPending = false;
    state.isRejected = false;
    state.isResolved = false;
    for(let i = 0; i<state.pages.length; i++) {
      let page = state.pages[i];
      state.isPending = state.isPending || page.isPending;
      state.isRejected = state.isRejected || page.isRejected;
      state.isResolved = !(state.isPending && state.isRejected) && page.isResolved;
    }
  }

  _fetchPage(page) {
    let offset = page.offset;
    let pageSize = this.state.pageSize;
    let stats = {totalPages: this.state.totalPages };
    return this._fetch.call(this, offset, pageSize, stats).then((records = []) => {
      let state = this.state.update((next)=> {
        next.stats = stats;
        if(page !== next.pages[offset]) { return; }
        // Filter on page update
        next.pages[offset] = page.resolve(records, this._filter);
        this._adjustTotalPages(next.pages, stats);
        this._adjustTotalRecords(next);
        this._setStateStatus(next);
      });
      this._observe(this.state = state);
    }).catch((error = {}) => {
      let state = this.state.update((next)=> {
        next.stats = stats;
        if(page !== next.pages[offset]) { return; }
        next.pages[offset] = page.reject(error);
        this._adjustTotalPages(next.pages, stats);
        this._adjustTotalRecords(next);
        this._setStateStatus(next);
      });
      this._observe(this.state = state);
    });
  }
}
