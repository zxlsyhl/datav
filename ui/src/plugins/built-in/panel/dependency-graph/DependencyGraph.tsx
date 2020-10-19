import React, { PureComponent } from 'react';
import _, { find, map, isUndefined, remove, each, has } from 'lodash';
import { PanelProps, withTheme, DatavTheme, toLegacyTableData } from 'src/packages/datav-core';
import { DependencyGraphOptions, CurrentData, QueryResponse, TableContent, ISelectionStatistics, IGraphMetrics, IGraph, IGraphNode, CyData, IGraphEdge } from './types';
import { css, cx } from 'emotion';
import { stylesFactory } from 'src/packages/datav-core';
import { NodeSingular, EdgeSingular, EventObject, EdgeCollection } from 'cytoscape';

import './index.less'
import { PlayCircleOutlined, PauseCircleOutlined, ApartmentOutlined, AimOutlined, PlusOutlined, MinusOutlined } from '@ant-design/icons';
import { Tooltip, Button } from 'antd';
import dummyData from "./dummyData";
import PreProcessor from './processing/preProcessor'
import GraphGenerator from './processing/graphGenerator'

import { initCytoscape, graphContainer, graphCanvas } from './cytoscape'
import layoutOptions from './layoutOptions'

interface Props extends PanelProps<DependencyGraphOptions> {
  theme: DatavTheme
}
interface State {
  paused: boolean
}

export class DependencyGraph extends PureComponent<Props, State> {
  validQueryTypes: boolean;
  currentData: CurrentData | undefined;
  preProcessor: PreProcessor = new PreProcessor(this);
  graphGenerator: GraphGenerator = new GraphGenerator(this);
  cy: cytoscape.Core;
  showStatistics: boolean = false;
  selectionId: string;
  receiving: TableContent[];
  sending: TableContent[];
  currentType: string;
  selectionStatistics: ISelectionStatistics;
  resolvedDrillDownLink: string;
  initResize: boolean = true;

  constructor(props) {
    super(props)
  }

  componentWillMount() {
    this.setState({
      paused: false
    })
  }

  componentDidMount() {
    if (!this.cy) {
      initCytoscape(this)
    }
  }

  _updateGraph(graph: IGraph) {
    const cyNodes = this._transformNodes(graph.nodes);
    const cyEdges = this._transformEdges(graph.edges);

    console.groupCollapsed("Updating graph");
    console.log("cytoscape nodes: ", JSON.parse(JSON.stringify(cyNodes)));
    console.log("cytoscape edges: ", JSON.parse(JSON.stringify(cyEdges)));
    console.groupEnd();

    const nodes = this.cy.nodes().toArray();
    const updatedNodes = this._updateOrRemove(nodes, cyNodes);

    // add new nodes
    //@ts-ignore
    this.cy.add(cyNodes);

    const edges = this.cy.edges().toArray();
    this._updateOrRemove(edges, cyEdges);

    // add new edges
    //@ts-ignore
    this.cy.add(cyEdges);

    if (this.initResize) {
      this.initResize = false;
      this.cy.resize();
      this.cy.reset();
      this.runLayout();
    } else {
      if (cyNodes.length > 0) {
        each(updatedNodes, node => {
          //@ts-ignore
          node.lock();
        });
        this.runLayout(true);
      }
    }
  }

  runLayout(unlockNodes: boolean = false) {
    const that = this;

    const options = {
      ...layoutOptions,
      stop: function () {
        if (unlockNodes) {
          that.unlockNodes();
        }
      }
    };

    this.cy.layout(options).run()
  }

  unlockNodes() {
    this.cy.nodes().forEach(node => {
      node.unlock();
    });
  }


  _transformEdges(edges: IGraphEdge[]): CyData[] {
    const cyEdges = map(edges, edge => {
      const cyEdge = {
        group: 'edges',
        data: {
          id: edge.source + ":" + edge.target,
          source: edge.source,
          target: edge.target,
          metrics: {
            ...edge.metrics
          }
        }
      };

      return cyEdge;
    });

    return cyEdges;
  }

  _transformNodes(nodes: IGraphNode[]): CyData[] {
    const cyNodes = map(nodes, node => {
      const result: CyData = {
        group: 'nodes',
        data: {
          id: node.name,
          type: node.type,
          external_type: node.external_type,
          metrics: {
            ...node.metrics
          }
        }
      };
      return result;
    });

    return cyNodes;
  }

  _updateOrRemove(dataArray: (NodeSingular | EdgeSingular)[], inputArray: CyData[]) {
    const elements: (NodeSingular | EdgeSingular)[] = [];
    for (let i = 0; i < dataArray.length; i++) {
      const element = dataArray[i];

      const cyNode = find(inputArray, { data: { id: element.id() } });

      if (cyNode) {
        element.data(cyNode.data);
        remove(inputArray, n => n.data.id === cyNode.data.id);
        elements.push(element);
      } else {
        element.remove();
      }
    }
    return elements;
  }

  isDataAvailable() {
    const dataExist = !isUndefined(this.currentData) && this.currentData.graph.length > 0;
    return dataExist;
  }

  processQueryData(data: QueryResponse[]) {
    this.validQueryTypes = this.hasOnlyTableQueries(data);

    if (this.hasAggregationVariable() && this.validQueryTypes) {

      const graphData = this.preProcessor.processData(data);

      console.groupCollapsed('Processed received data');
      console.log('raw data: ', data);
      console.log('graph data: ', graphData);
      console.groupEnd();

      this.currentData = graphData;
    } else {
      this.currentData = undefined;
    }
  }

  hasOnlyTableQueries(inputData: QueryResponse[]) {
    var result: boolean = true;

    each(inputData, dataElement => {
      if (!has(dataElement, 'columns')) {
        result = false;
      }
    });

    return result;
  }

  hasAggregationVariable() {
    const templateVariable: any = _.find(this.props.dashboard.templating.list, {
      name: 'aggregationType'
    });

    return !!templateVariable;
  }


  onSelectionChange(event: EventObject) {
    const selection = this.cy.$(':selected');

    if (selection.length === 1) {
      this.showStatistics = true;
      this.updateStatisticTable();
    } else {
      this.showStatistics = false;
    }
    this.forceUpdate()
  }

  updateStatisticTable() {
    const selection = this.cy.$(':selected');

    if (selection.length === 1) {
      const currentNode: NodeSingular = selection[0];
      this.selectionId = currentNode.id();
      this.currentType = currentNode.data('type');
      const receiving: TableContent[] = [];
      const sending: TableContent[] = [];
      const edges: EdgeCollection = selection.connectedEdges();

      const metrics: IGraphMetrics = selection.nodes()[0].data('metrics');
      const requestCount = _.defaultTo(metrics.rate, -1);
      const errorCount = _.defaultTo(metrics.error_rate, -1);
      const duration = _.defaultTo(metrics.response_time, -1);
      const threshold = _.defaultTo(metrics.threshold, -1);

      this.selectionStatistics = {};

      if (requestCount >= 0) {
        this.selectionStatistics.requests = Math.floor(requestCount);
      }
      if (errorCount >= 0) {
        this.selectionStatistics.errors = Math.floor(errorCount);
      }
      if (duration >= 0) {
        this.selectionStatistics.responseTime = Math.floor(duration);

        if (threshold >= 0) {
          this.selectionStatistics.threshold = Math.floor(threshold);
          this.selectionStatistics.thresholdViolation = duration > threshold;
        }
      }

      for (let i = 0; i < edges.length; i++) {

        const actualEdge: EdgeSingular = edges[i];
        const sendingCheck: boolean = actualEdge.source().id() === this.selectionId;
        let node: NodeSingular;

        if (sendingCheck) {
          node = actualEdge.target();
        }
        else {
          node = actualEdge.source()
        }

        const sendingObject: TableContent = {
          name: node.id(),
          responseTime: "-",
          rate: "-",
          error: "-"
        };

        const edgeMetrics: IGraphMetrics = actualEdge.data('metrics');
        const { response_time, rate, error_rate } = edgeMetrics;

        if (rate != undefined) {
          sendingObject.rate = Math.floor(rate).toString();
        }
        if (response_time != undefined) {
          sendingObject.responseTime = Math.floor(response_time) + " ms";
        }
        if (error_rate != undefined && rate != undefined) {
          sendingObject.error = Math.floor(error_rate / (rate / 100)) + "%";
        }

        if (sendingCheck) {
          sending.push(sendingObject);
        } else {
          receiving.push(sendingObject);
        }
      }
      this.receiving = receiving;
      this.sending = sending;

      this.generateDrillDownLink();
    }
  }

  generateDrillDownLink() {
    const { drillDownLink } = this.props.options;
    const link = drillDownLink.replace('{}', this.selectionId);
    this.resolvedDrillDownLink = this.props.dashboard.templateSrv.replace(link);
  }

  getAssetUrl(assetName: string) {
    var baseUrl = 'public/plugins/' + this.props.panel.type;
    return baseUrl + '/assets/' + assetName;
  }

  getTypeSymbol(type, resolveName = true) {
    if (!type) {
      return this.getAssetUrl('default.png');
    }

    if (!resolveName) {
      return this.getAssetUrl(type);
    }

    const { serviceIcons } = this.props.options;

    const icon = serviceIcons[type.toLowerCase()]

    return !icon ? this.getAssetUrl(icon.filename + '.png') : this.getAssetUrl('default.png')
  }

  toggleAnimation = () => {
    const paused = !this.state.paused
    this.setState({
      ...this.state,
      paused
    })

    if (!paused) {
      graphCanvas.startAnimation();
    } else {
      graphCanvas.stopAnimation();
    }
  }

  fit = () => {
    const selection = graphCanvas.selectionNeighborhood;
    if (selection && !selection.empty()) {
      this.cy.fit(selection, 30);
    } else {
      this.cy.fit();
    }
  }

  zoom = (zoom) => {
    const zoomStep = 0.25 * zoom;
    const zoomLevel = Math.max(0.1, this.cy.zoom() + zoomStep);
    this.cy.zoom(zoomLevel);
  }

  render() {
    const { options, data, width, height, theme, panel } = this.props

    const { paused } = this.state

    if (this.props.options.showDummyData) {
      this.processQueryData(dummyData);
    } else {
      // change data fomart from DataFrame to talbe data
      const respData: QueryResponse[] = []
      for (const series of data.series) {
        respData.push(toLegacyTableData(series))
      }
      this.processQueryData(respData)
    }

    const styles = getStyles();

    setTimeout(() => {
      if (this.cy && this.isDataAvailable()) {
        const graph: IGraph = this.graphGenerator.generateGraph(this.currentData.graph);
        this._updateGraph(graph);
      }
    }, 500)
    return (
      <div
        className={cx(
          styles.wrapper,
          css`
              width: ${width}px;
              height: ${height}px;
            `
        )}
      >
        <div className="service-dependency-graph-panel">
          <div className="graph-container">
            <div className="service-dependency-graph">
              <div id={`canvas-container-${panel.id}`} style={{ width: '100%', height: '100%', overflow: 'hidden' }}></div>

              <div className="zoom-button-container">
                <Tooltip placement="right" title={paused ? "Play" : "Pause"}><Button className="btn navbar-button" onClick={this.toggleAnimation}>{paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}</Button></Tooltip>
                <Tooltip placement="right" title="Layout as a tree"><Button className="btn navbar-button" onClick={() => this.runLayout()}><ApartmentOutlined /></Button></Tooltip>
                <Tooltip placement="right" title="Fit to the canvas"><Button className="btn navbar-button" onClick={this.fit}><AimOutlined /></Button></Tooltip>
                <Tooltip placement="right" title="Zoom in"><Button className="btn navbar-button" onClick={() => this.zoom(+1)}><PlusOutlined /></Button></Tooltip>
                <Tooltip placement="right" title="Zoom out"><Button className="btn navbar-button" onClick={() => this.zoom(-1)}><MinusOutlined /></Button></Tooltip>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}



export default withTheme(DependencyGraph)

const getStyles = stylesFactory(() => {
  return {
    wrapper: css`
      position: relative;
    `,
    svg: css`
      position: absolute;
      top: 0;
      left: 0;
    `,
    textBox: css`
      position: absolute;
      bottom: 0;
      left: 0;
      padding: 10px;
    `,
  };
});
