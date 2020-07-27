/* globals d3 */
import GoldenLayoutView from '../common/GoldenLayoutView.js';
import LinkedMixin from '../common/LinkedMixin.js';
import SvgViewMixin from '../common/SvgViewMixin.js';
import CursoredViewMixin from '../common/CursoredViewMixin.js';
import normalizeWheel from '../../utils/normalize-wheel.js';
import cleanupAxis from '../../utils/cleanupAxis.js';

class GanttView extends CursoredViewMixin(SvgViewMixin(LinkedMixin(GoldenLayoutView))) {
  constructor (argObj) {
    argObj.resources = [
      { type: 'less', url: 'views/GanttView/style.less' },
      { type: 'text', url: 'views/GanttView/template.svg' }
    ];
    super(argObj);
    this.localXScale = d3.scaleLinear();
    this.xScale = d3.scaleLinear();
    this.yScale = d3.scaleBand()
      .paddingInner(0.2)
      .paddingOuter(0.1);
    this.yScale.invert = function(x) { // think about the padding later
      var domain = this.domain();
      var range = this.range();
      var scale = d3.scaleQuantize().domain(range).range(domain);
      return scale(x);
    };

    // Some things like SVG clipPaths require ids instead of classes...
    this.uniqueDomId = `GanttView${GanttView.DOM_COUNT}`;
    GanttView.DOM_COUNT++;
    this.wasRerendered = false;
    this.highlightedData = null;
    this.ClickState = {"background":0, "hover":1, "singleClick":2, "doubleClick":3};
    this.IntervalListMode = {all: "all", primitive: "primitive", guid: "guid", duration: "duration"};
    this.isMouseInside = false;
  }

  get isLoading () {
    return super.isLoading || this.linkedState.isLoadingIntervals || this.linkedState.isLoadingTraceback;
  }
  get isEmpty () {
    return this.error || !this.linkedState.isAggBinsLoaded;
  }
  getChartBounds () {
    const bounds = this.getAvailableSpace();
    const result = {
      width: bounds.width - this.margin.left - this.margin.right,
      height: bounds.height - this.margin.top - this.margin.bottom,
      left: bounds.left + this.margin.left,
      top: bounds.top + this.margin.top,
      right: bounds.right - this.margin.right,
      bottom: bounds.bottom - this.margin.bottom
    };
    this.xScale.range([0, result.width]);
    this.yScale.range([0, result.height]);
    return result;
  }
  getSpilloverWidth(width){
    return width*3;
  }
  setup () {
    super.setup();

    this.content.html(this.resources[1]);

    this.margin = {
      top: 20,
      right: 20,
      bottom: 40,
      left: 40
    };
    this._bounds = this.getChartBounds();
    this.content.select('.chart')
      .attr('transform', `translate(${this.margin.left},${this.margin.top})`);


    //add width of gantt chart to model
    // for leightweight querying and aggregating
    this.linkedState.setGanttXResolution(this.getSpilloverWidth(this._bounds.width));


    // Create a view-specific clipPath id, as there can be more than one
    // GanttView in the app
    const clipId = this.uniqueDomId + 'clip';
    this.content.select('clipPath')
      .attr('id', clipId);
    this.content.select('.clippedStuff')
      .attr('clip-path', `url(#${clipId})`);
    this.drawClip();

    // Deselect the primitive / interval selections when the user clicks the background
    this.content.select('.background')
      .on('click', () => {
        this.linkedState.selectPrimitive(null);
        this.linkedState.selectIntervalId(null);
      });


    // Initialize the scales / stream
    this.xScale.domain(this.linkedState.intervalWindow);
    this.yScale.domain(this.linkedState.metadata.locationNames);

    // Set up zoom / pan interactions
    this.setupZoomAndPan();

    // // Set up listeners on the model
    this.linkedState.on('newIntervalWindow', () => {
      // Update scales whenever something changes the brush
      this.xScale.domain(this.linkedState.intervalWindow);
      // Update the axes immediately for smooth dragging responsiveness
      this.drawAxes();
      // Make sure we render eventually
      // this.render();
    });
    // const showSpinner = () => { this.drawSpinner(); };
    // this.linkedState.on('intervalStreamStarted', showSpinner);
    // this.linkedState.on('tracebackStreamStarted', showSpinner);
    this.linkedState.on('intervalsUpdated', () => {
      this.xScale.domain(this.linkedState.intervalWindow);
      // Update the axes immediately for smooth dragging responsiveness
      this.drawAxes();
      // Make sure we render eventually
      this.render();
    });
    this.linkedState.on('newIntervalHistogramWindow', () => {
        this.drawHighlightedBars(this.IntervalListMode.all);
        this.fetchIntervalList(this.linkedState.intervalHistogramBegin,
            this.linkedState.intervalHistogramEnd,
            this.IntervalListMode.duration);
    });
    // this.linkedState.on('tracebackUpdated', () => {
    //   // This is an incremental update; we don't need to do a full render()...
    //   // (but still debounce this, as we don't want to call drawLinks() for
    //   // every new interval)
    //   window.clearTimeout(this._incrementalTracebackTimeout);
    //   this._incrementalTracebackTimeout = window.setTimeout(() => {
    //     this.drawLinks(this.linkedState.getCurrentTraceback());
    //   });
    // });
    // const justFullRender = () => { this.render(); };
    // this.linkedState.on('primitiveSelected', justFullRender);
    // this.linkedState.on('intervalStreamFinished', justFullRender);
    // this.linkedState.on('tracebackStreamFinished', justFullRender);

      this.currentClickState = this.ClickState.background;
      var __self = this;
      // mouse events

    this.canvasElement = this.content.select('.gantt-canvas')
        .on('click', function() {
            __self.clearAllTimer();
            var dm = d3.mouse(__self.content.select('.canvas-container').node());
            __self._mouseClickTimeout = window.setTimeout(async () => {
                __self.drawHighlightedBars(__self.IntervalListMode.all);
                __self.fetchIntervalList(dm[0], dm[1], __self.IntervalListMode.primitive);
            }, 300);
        })
        .on('mouseleave', function () {
            __self.isMouseInside = false;
            __self.clearAllTimer();
        })
        .on('mouseenter',function () {
            __self.isMouseInside = true;
        })
        .on('mousemove', function() {
            __self.clearAllTimer();
            if(__self.currentClickState === __self.ClickState.background || __self.currentClickState === __self.ClickState.hover) {
                var dm = d3.mouse(__self.content.select('.canvas-container').node());
                this._mouseHoverTimeout = window.setTimeout(async () => {
                    if(__self.isMouseInside === true) {
                        __self.drawHighlightedBars(__self.IntervalListMode.all);
                        __self.fetchIntervalList(dm[0], dm[1], __self.IntervalListMode.guid);
                    }
                }, 100);
            }
        })
        .on('dblclick', function() {
            __self.clearAllTimer();
            var dm = d3.mouse(__self.content.select('.canvas-container').node());
            __self.fetchIntervalInfoAndShowTooltip(dm[0], dm[1]);
        });
  }
  clearAllTimer() {
      if(this._mouseHoverTimeout) {
          window.clearTimeout(this._mouseHoverTimeout);
          this._mouseHoverTimeout = null;
      }
      if(this._mouseClickTimeout) {
          window.clearTimeout(this._mouseClickTimeout);
          this._mouseClickTimeout = null;
      }
      if(this.primitiveFetchTimeout) {
          window.clearTimeout(this.primitiveFetchTimeout);
          this.primitiveFetchTimeout = null;
      }
  }

  fetchIntervalInfoAndShowTooltip(xx, yy){
      var __self = this;
      var tm = __self.localXScale.invert(xx);
      var loc = __self.yScale.invert(yy);
      //this function will replace the fetching of intervals
      window.clearTimeout(this.intervalFetchTimeout);
      this.intervalFetchTimeout = window.setTimeout(async () => {
          //*****NetworkError on reload is here somewhere******//
          const label = encodeURIComponent(this.linkedState.label);
          var endpt = `/datasets/${label}/getIntervalInfo?timestamp=${Math.floor(tm)}&location=${loc}`;
          fetch(endpt)
              .then((response) => {
                  return response.json();
              })
              .then((data) => {
                  if(data.length > 0) {
                      data[0].metrics = undefined;
                      data[0].intervalId = undefined;
                      data[0].lastParentInterval = undefined;
                      var dr = __self.canvasElement.node().getBoundingClientRect();
                      dr.x = xx - __self._bounds.width + 100;
                      dr.y = yy;

                      window.controller.tooltip.show({
                          content: `<pre>${JSON.stringify(data[0], null, 2)}</pre>`,
                          targetBounds: dr,
                          hideAfterMs: null
                      });
                      __self.currentClickState = __self.ClickState.doubleClick;
                  } else {
                      __self.currentClickState = __self.ClickState.background;
                      window.controller.tooltip.hide();
                  }
              })
              .catch(err => {
                  err.text.then( errorMessage => {
                      console.warn(errorMessage);
                  });
              });
      }, 100);
  }
  fetchIntervalList(xx, yy, mode){
      var __self = this;
      var tm = 0;
      var loc = 0;
      if(mode === this.IntervalListMode.guid || mode === this.IntervalListMode.primitive) {
          tm = __self.localXScale.invert(xx);
          loc = __self.yScale.invert(yy);
      } else if(mode === this.IntervalListMode.duration) {
          tm = xx;
          loc = yy;
      }
      //this function will replace the fetching of intervals
      window.clearTimeout(this.primitiveFetchTimeout);
      this.primitiveFetchTimeout = window.setTimeout(async () => {
          const label = encodeURIComponent(this.linkedState.label);
          var begin = this.linkedState.intervalWindow[0];
          var end = this.linkedState.intervalWindow[1];
          var endpt = `/datasets/${label}/getIntervalList?`;
          endpt += `enter=${Math.floor(tm)}&location=${loc}&begin=${Math.floor(begin)}&end=${Math.ceil(end)}&mode=${mode}`;
          if(mode === this.IntervalListMode.duration) {
              endpt += `&leave=${Math.ceil(loc)}`;// loc in location isnt used if mode is duration
          }
          fetch(endpt)
              .then((response) => {
                  return response.json();
              })
              .then((data) => {
                  __self.highlightedData = data;
                  if(mode === __self.IntervalListMode.primitive) {
                      __self.currentClickState = __self.ClickState.singleClick;
                  } else if(mode === __self.IntervalListMode.guid) {
                      __self.currentClickState = __self.ClickState.hover;
                  } else {
                      __self.currentClickState = __self.ClickState.background;
                  }
                  __self.drawHighlightedBars(mode);
              })
              .catch(err => {
                  err.text.then( errorMessage => {
                      console.warn(errorMessage);
                  });
              });
      }, 100);
    }
  draw () {
    super.draw();

    if (this.isHidden) {
      return;
    } else if (this.isEmpty) {
      if (this.error) {
        this.emptyStateDiv.html(`<p>Error communicating with the server</p>`);
      } else if (this.linkedState.tooManyIntervals) {
        this.emptyStateDiv.html('<p>Too much data; scroll to zoom in</p>');
      } else {
        this.emptyStateDiv.html('<p>No data in the current view</p>');
      }
    }

    // Update the dimensions of the plot in case we were resized
    // (window.getBoundingClientRect() is semi-expensive, so we DON'T update
    // this during incremental / immediate draw calls in setup()'s listeners or
    // zooming / panning that need more responsiveness)
    this._bounds = this.getChartBounds();
    // this.linkedState.setGanttXResolution(this.getSpilloverWidth(this._bounds.width));

    // Update whether we're showing the spinner
    this.drawSpinner();
    // Update the clip rect
    this.drawClip();
    // Update the axes (also updates scales)
    this.drawAxes();

    // Update the bars
    // this.drawBars(this.linkedState.getCurrentIntervals());
    this.drawBarsCanvas(this.linkedState.getCurrentGanttAggregrateBins());
    // Update the links
    this.drawLinks(this.linkedState.getCurrentTraceback());
  }
  drawSpinner () {
    this.content.select('.small.spinner').style('display', this.isLoading ? null : 'none');
  }
  drawClip () {
    this.content.select('clipPath rect')
      .attr('width', this._bounds.width)
      .attr('height', this._bounds.height);
  }
  drawAxes () {
    // Update the x axis
    const xAxisGroup = this.content.select('.xAxis')
      .attr('transform', `translate(0, ${this._bounds.height})`)
      .call(d3.axisBottom(this.xScale));
    cleanupAxis(xAxisGroup);

    // Position the x label
    this.content.select('.xAxisLabel')
      .attr('x', this._bounds.width / 2)
      .attr('y', this._bounds.height + this.margin.bottom - this.emSize / 2);

    // Update the y axis
    let yTicks = this.content.select('.yAxis').selectAll('.tick')
      .data(this.yScale.domain());
    yTicks.exit().remove();
    const yTicksEnter = yTicks.enter().append('g')
      .classed('tick', true);
    yTicks = yTicks.merge(yTicksEnter);

    yTicks.attr('transform', d => `translate(0,${this.yScale(d) + this.yScale.bandwidth() / 2})`);

    const lineOffset = -this.yScale.step() / 2;
    yTicksEnter.append('line');
    yTicks.select('line')
      .attr('x1', 0)
      .attr('x2', this._bounds.width)
      .attr('y1', lineOffset)
      .attr('y2', lineOffset);

    yTicksEnter.append('text');
    yTicks.select('text')
      .attr('text-anchor', 'end')
      .attr('y', '0.35em')
      .text(d => d);

    // Position the y label
    this.content.select('.yAxisLabel')
      .attr('transform', `translate(${-this.emSize},${this._bounds.height / 2}) rotate(-90)`);
  }
  drawBarsCanvas(aggBins){
      var border = 1;

      this.localXScale.domain(this.xScale.domain());
      this.localXScale.range([this._bounds.width, this.getSpilloverWidth(this._bounds.width)-this._bounds.width]);

      /***** DONT FORGET TO ADD FLAG FOR IF USING NATIVE OR OVERLOADED VIEW SCALE****/

      // we need a canvas already
      // first we focus on moving canvas to the correct place

      if (!this.initialDragState) {
        this.content.select('.canvas-container')
          .attr('width', this.getSpilloverWidth(this._bounds.width))
          .attr('height', this._bounds.height)
          .attr('transform', `translate(${-this._bounds.width}, 0)`);

        this.canvasElement
                    .attr('width', this.getSpilloverWidth(this._bounds.width))
                    .attr('height', this._bounds.height);

        var ctx = this.canvasElement.node().getContext("2d");

        ctx.clearRect(0, 0,  this.getSpilloverWidth(this._bounds.width), this._bounds.height);


        for (var location in aggBins.data){
          var loc_offset = this.yScale(parseInt(aggBins.data[location].location));
          for (var bucket in aggBins.data[location].histogram){

            var bucket_pix_offset = this.localXScale(this.linkedState.getTimeStampFromBin(bucket, aggBins.metadata));
            var pixel = aggBins.data[location].histogram[bucket];
            if (pixel === 1){
              ctx.fillStyle = this.linkedState.contentBorderColor;
              ctx.fillRect(bucket_pix_offset, loc_offset, 1, border);
              ctx.fillRect(bucket_pix_offset, (loc_offset-border)+this.yScale.bandwidth(), 1, border);
              ctx.fillStyle = this.linkedState.contentFillColor;
              ctx.rect(bucket_pix_offset, loc_offset+border, 1, this.yScale.bandwidth()-(2*border));
            }
            if (pixel < 1 && pixel > 0){
              ctx.fillStyle = this.linkedState.contentBorderColor;
              ctx.fillRect(bucket_pix_offset, loc_offset, border, this.yScale.bandwidth());
            }
          }
        }

        ctx.fillStyle = this.linkedState.contentFillColor;
        ctx.fill();
        this.visibleAggBinsMetadata = aggBins.metadata;
      }
      this.ctx = ctx;
      this.wasRerendered = true;

  }
  drawHighlightedBars(mode) {
      if(this.highlightedData == null)return;
      var border = 1;
      var fillColor = this.linkedState.contentFillColor;
      var borderColor = this.linkedState.contentBorderColor;
      if(mode === this.IntervalListMode.guid) {
          fillColor = this.linkedState.mouseHoverSelectionColor;
      } else if(mode === this.IntervalListMode.primitive) {
          fillColor = this.linkedState.selectionColor;
      } else if(mode === this.IntervalListMode.duration) {
          fillColor = this.linkedState.selectionColor;
      }
      var ctx = this.canvasElement.node().getContext("2d");
      var bins = this.getSpilloverWidth(this._bounds.width);
      var notDrawn = true;
      for(var loc in this.highlightedData) {
          var loc_offset = this.yScale(parseInt(loc));
          if(this.highlightedData[loc].length === 0)continue;
          notDrawn = false;
          for(var i = 0; i < bins; i++){
              var thisTime = this.linkedState.getTimeStampFromBin(i, this.visibleAggBinsMetadata);
              var bucket_pix_offset = this.localXScale(thisTime);
              for (var elm in this.highlightedData[loc]) {
                  if(thisTime >= this.highlightedData[loc][elm]['enter'] && thisTime <= this.highlightedData[loc][elm]['leave']) {

                      ctx.fillStyle = borderColor;
                      ctx.fillRect(bucket_pix_offset, loc_offset, 1, border);
                      ctx.fillRect(bucket_pix_offset, (loc_offset-border)+this.yScale.bandwidth(), 1, border);


                      ctx.fillStyle = fillColor;
                      ctx.fillRect(bucket_pix_offset, loc_offset+border, 1, this.yScale.bandwidth()-(2*border));
                      break;
                  }
                  if(thisTime < this.highlightedData[loc][elm]['enter']) {
                      break;
                  }
              }
          }
      }
      if(notDrawn) {
          this.currentClickState = this.ClickState.background;
      }
  }
  drawBars (intervals) {
    if (!this.initialDragState) {
      // Remove temporarily patched transformations
      this.content.select('.bars').attr('transform', null);
    }

    let bars = this.content.select('.bars')
      .selectAll('.bar').data(d3.entries(intervals), d => d.key);
    bars.exit().remove();
    const barsEnter = bars.enter().append('g')
      .classed('bar', true);
    bars = bars.merge(barsEnter);

    bars.attr('transform', d => `translate(${this.xScale(d.value.enter.Timestamp)},${this.yScale(d.value.Location)})`);

    barsEnter.append('rect')
      .classed('area', true);
    barsEnter.append('rect')
      .classed('outline', true);
    bars.selectAll('rect')
      .attr('height', this.yScale.bandwidth())
      .attr('width', d => this.xScale(d.value.leave.Timestamp) - this.xScale(d.value.enter.Timestamp));

    bars.select('.area')
      .style('fill', d => {
        if (d.value.GUID === this.linkedState.selectedGUID) {
          return this.linkedState.mouseHoverSelectionColor;
        } else if (d.value.Primitive === this.linkedState.selectedPrimitive) {
          return this.linkedState.selectionColor;
        } else {
          return null;
        }
      });

    bars.select('.outline')
    // TODO: make this like the area fill
      .style('stroke', d => {
        if (d.value.hasOwnProperty('inTraceBack') && d.value.inTraceBack) {
          return this.linkedState.traceBackColor;
        } else if (d.value.Primitive === this.linkedState.selectedPrimitive) {
          return this.linkedState.selectionColor;
        } else {
          return null;
        }
      });
    bars
      .classed('selected', d => d.value.Primitive === this.linkedState.selectedPrimitive)
      .on('click', d => {
        if (!d.value.Primitive) {
          console.warn(`No (consistent) primitive for interval: ${JSON.stringify(d.value, null, 2)}`);
          if (d.value.enter.Primitive) {
            if (this.linkedState.selectedPrimitive !== d.value.enter.Primitive) {
              this.linkedState.selectPrimitive(d.value.enter.Primitive);
            } else {
              this.linkedState.selectPrimitive(null);
            }
          }
        } else {
          if (this.linkedState.selectedPrimitive !== d.value.Primitive) {
            this.linkedState.selectPrimitive(d.value.Primitive);
          } else {
            this.linkedState.selectPrimitive(null);
          }
        }

        if (!d.value.intervalId) {
          this.linkedState.selectIntervalId(null);
        } else if (d.value.intervalId === this.linkedState.selectedIntervalId) {
          this.linkedState.selectIntervalId(null);
        } else {
          this.linkedState.selectIntervalId(d.value.intervalId);
        }
        this.render();
      }).on('dblclick', function (d) {
        window.controller.tooltip.show({
          content: `<pre>${JSON.stringify(d.value, null, 2)}</pre>`,
          targetBounds: this.getBoundingClientRect(),
          hideAfterMs: null
        });
      }).on('mouseenter', d => {
        if (!d.value.GUID) {
          console.warn(`No (consistent) GUID for interval: ${JSON.stringify(d.value, null, 2)}`);
          if (d.value.enter.GUID) {
            this.linkedState.selectGUID(d.value.enter.GUID);
          }
        } else {
          this.linkedState.selectGUID(d.value.GUID);
        }
        this.render();
      }).on('mouseleave', () => {
        window.controller.tooltip.hide();
        this.linkedState.selectGUID(null);
        this.render();
      });
  }
  drawLinks (linkData) {
    if (!this.initialDragState) {
      // Remove temporarily patched transformations
      this.content.select('.links').attr('transform', null);
    }

    let links = this.content.select('.links')
      .selectAll('.link').data(linkData, d => d.intervalId);
    links.exit().remove();
    const linksEnter = links.enter().append('g')
      .classed('link', true);
    links = links.merge(linksEnter);

    let halfwayOffset = this.yScale.bandwidth() / 2;

    linksEnter.append('line')
      .classed('line', true);
    links.selectAll('line')
      .attr('x1', d => this.xScale(d.lastParentInterval.endTimestamp))
      .attr('x2', d => this.xScale(d.enter.Timestamp))
      .attr('y1', d => this.yScale(d.lastParentInterval.location) + halfwayOffset)
      .attr('y2', d => this.yScale(d.Location) + halfwayOffset);
  }
  setupZoomAndPan () {
    this.initialDragState = null;
    let latentWidth = null;
    const clampWindow = (begin, end) => {
      // clamp to the lowest / highest possible values
      if (begin <= this.linkedState.beginLimit) {
        const offset = this.linkedState.beginLimit - begin;
        begin += offset;
        end += offset;
      }
      if (end >= this.linkedState.endLimit) {
        const offset = end - this.linkedState.endLimit;
        begin -= offset;
        end -= offset;
      }
      return { begin, end };
    };
    this.content
      .on('wheel', () => {

          this.initialDragState = null;
        const zoomFactor = 1.05 ** (normalizeWheel(d3.event).pixelY / 100);
        const originalWidth = this.linkedState.end - this.linkedState.begin;
        // Clamp the width to a min of 10ms, and the largest possible size
        let targetWidth = Math.max(zoomFactor * originalWidth, 10);
        targetWidth = Math.min(targetWidth, this.linkedState.endLimit - this.linkedState.beginLimit);
        // Compute the new begin / end points, centered on where the user is mousing

        /****** HACK AND FIX ALSO
                I need to tie 1 width to an clear value which is realted to the size of our overflow ******/
        const overflowAdjustedMousedScreenPont = d3.event.clientX - this._bounds.left - this.margin.left + this._bounds.width;
        /******* HACK FIX ********/

        const mousedScreenPoint = d3.event.clientX - this._bounds.left - this.margin.left;
        const mousedPosition = this.xScale.invert(mousedScreenPoint);
        const begin = mousedPosition - (targetWidth / originalWidth) * (mousedPosition - this.linkedState.begin);
        const end = mousedPosition + (targetWidth / originalWidth) * (this.linkedState.end - mousedPosition);
        const actualBounds = clampWindow(begin, end);



        // For responsiveness, draw the axes immediately
        this.drawAxes();

        // Patch a temporary scale transform to the bars / links layers (this
        // gets removed by full drawBars() / drawLinks() calls)

        latentWidth = originalWidth;
        const actualZoomFactor = latentWidth / ((actualBounds.end - actualBounds.begin));
        const zoomCenter = (1 - actualZoomFactor) * overflowAdjustedMousedScreenPont;

        // this.content.selectAll('.bars, .links')
        // .attr('transform', `translate(${zoomCenter}, 0) scale(${actualZoomFactor}, 1)`);

        // There isn't a begin / end wheel event, so trigger the update across
        // views immediately
        // window.clearTimeout(this._incrementalIntervalTimeout);
        // this._incrementalIntervalTimeout = window.setTimeout(() => {

        var ctx = this.canvasElement.node().getContext("2d");

        var buffer = document.createElement("CANVAS");
        buffer.height = this.canvasElement.attr('height');
        buffer.width = this.canvasElement.attr('width');

        this.buff = buffer.getContext("2d");
        this.buff.drawImage(ctx.canvas, 0, 0);


        ctx.save();
        ctx.clearRect(0, 0,  this.getSpilloverWidth(this._bounds.width), this._bounds.height);
        ctx.translate(zoomCenter, 0);
        ctx.scale(actualZoomFactor, 1);
        ctx.drawImage(this.buff.canvas, 0, 0);
        ctx.restore();

        this.linkedState.setIntervalWindow(actualBounds);

        // Show the small spinner to indicate that some of the stuff the user
        // sees may be inaccurate (will be hidden once the full draw() call
        // happens)
        this.content.select('.small.spinner').style('display', null);
        this.currentClickState = this.ClickState.background;
      }).call(d3.drag()
        .on('start', () => {
          this.initialDragState = {
            begin: this.linkedState.begin,
            end: this.linkedState.end,
            x: this.xScale.invert(d3.event.x),
            scale: d3.scaleLinear()
              .domain(this.xScale.domain())
              .range(this.xScale.range())
          };

          // var ctx = this.canvasElement.node().getContext("2d");
          //
          // var buffer = document.createElement("CANVAS");
          // buffer.height = this.canvasElement.attr('height');
          // buffer.width = this.canvasElement.attr('width');
          //
          // this.buff = buffer.getContext("2d");
          // this.buff.drawImage(ctx.canvas, 0, 0);
        })
        .on('drag', () => {
          if(this.wasRerendered === true){
            this.initialDragState = {
              begin: this.linkedState.begin,
              end: this.linkedState.end,
              x: this.xScale.invert(d3.event.x),
              scale: d3.scaleLinear()
                .domain(this.xScale.domain())
                .range(this.xScale.range())
            };

            var ctx = this.canvasElement.node().getContext("2d");

            var buffer = document.createElement("CANVAS");
            buffer.height = this.canvasElement.attr('height');
            buffer.width = this.canvasElement.attr('width');

            this.buff = buffer.getContext("2d");
            this.buff.drawImage(ctx.canvas, 0, 0);

            this.wasRerendered = false;
          }

          const mousedPosition = this.initialDragState.scale.invert(d3.event.x);
          const dx = this.initialDragState.x - mousedPosition;
          const begin = this.initialDragState.begin + dx;
          const end = this.initialDragState.end + dx;
          const actualBounds = clampWindow(begin, end);

          // Don't bother triggering a full update mid-drag...
          // For responsiveness, draw the axes immediately (the debounced, full
          // render() triggered by changing linkedState may take a while)
          this.drawAxes();
          // this.drawBarsCanvas(this.linkedState.getCurrentGanttAggregrateBins());

          // Patch a temporary translation to the bars / links layers (this gets
          // removed by full drawBars() / drawLinks() calls)
          const shift = this.initialDragState.scale(this.initialDragState.begin) -
          this.initialDragState.scale(actualBounds.begin);

          var ctx = this.canvasElement.node().getContext("2d");

          ctx.save();
          ctx.clearRect(0, 0,  this.getSpilloverWidth(this._bounds.width), this._bounds.height);
          ctx.translate(shift, 0);
          ctx.drawImage(this.buff.canvas, 0, 0);
          ctx.restore();


          // Show the small spinner to indicate that some of the stuff the user
          // sees may be inaccurate (will be hidden once the full draw() call
          // happens)
          this.content.select('.small.spinner').style('display', null);

          // d3's drag behavior captures + prevents updating the cursor, so do
          // that manually
          this.linkedState.moveCursor(mousedPosition);
          this.updateCursor();
          this.linkedState.setIntervalWindow(clampWindow(begin, end));
        })
        .on('end', () => {
          const dx = this.initialDragState.x - this.initialDragState.scale.invert(d3.event.x);
          if(dx !== 0) {
              const begin = this.initialDragState.begin + dx;
              const end = this.initialDragState.end + dx;
              this.initialDragState = null;
              this.buff = null;

              this.linkedState.setIntervalWindow(clampWindow(begin, end));
              this.currentClickState = this.ClickState.background;
          }
        }));
  }
}
GanttView.DOM_COUNT = 1;
export default GanttView;
