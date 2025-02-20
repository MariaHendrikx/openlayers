import Map from '../src/ol/Map.js';
import View from '../src/ol/View.js';
import FullScreen from '../src/ol/control/FullScreen.js';
import Layer from '../src/ol/layer/Layer.js';
import Source from '../src/ol/source/Source.js';
import Worker from 'worker-loader!./offscreen-canvas.worker.js'; //eslint-disable-line
import {createXYZ} from '../src/ol/tilegrid.js';
import {
  compose,
  create,
  toString as toTransformString,
} from '../src/ol/transform.js';

const worker = new Worker();

let container,
  transformContainer,
  canvas,
  rendering,
  workerFrameState,
  mainThreadFrameState;

// Transform the container to account for the difference between the (newer)
// main thread frameState and the (older) worker frameState
function updateContainerTransform() {
  if (workerFrameState) {
    const viewState = mainThreadFrameState.viewState;
    const renderedViewState = workerFrameState.viewState;
    const center = viewState.center;
    const resolution = viewState.resolution;
    const rotation = viewState.rotation;
    const renderedCenter = renderedViewState.center;
    const renderedResolution = renderedViewState.resolution;
    const renderedRotation = renderedViewState.rotation;
    const transform = create();
    // Skip the extra transform for rotated views, because it will not work
    // correctly in that case
    if (!rotation) {
      compose(
        transform,
        (renderedCenter[0] - center[0]) / resolution,
        (center[1] - renderedCenter[1]) / resolution,
        renderedResolution / resolution,
        renderedResolution / resolution,
        rotation - renderedRotation,
        0,
        0,
      );
    }
    transformContainer.style.transform = toTransformString(transform);
  }
}

const map = new Map({
  layers: [
    new Layer({
      render: function (frameState) {
        if (!container) {
          container = document.createElement('div');
          container.style.position = 'absolute';
          container.style.width = '100%';
          container.style.height = '100%';
          transformContainer = document.createElement('div');
          transformContainer.style.position = 'absolute';
          transformContainer.style.width = '100%';
          transformContainer.style.height = '100%';
          container.appendChild(transformContainer);
          canvas = document.createElement('canvas');
          canvas.style.position = 'absolute';
          canvas.style.left = '0';
          canvas.style.transformOrigin = 'top left';
          transformContainer.appendChild(canvas);
        }
        mainThreadFrameState = frameState;
        updateContainerTransform();
        if (!rendering) {
          rendering = true;
          worker.postMessage({
            action: 'render',
            frameState: {
              layerIndex: 0,
              wantedTiles: {},
              usedTiles: {},
              viewHints: frameState.viewHints.slice(0),
              postRenderFunctions: [],
              viewState: {
                center: frameState.viewState.center.slice(0),
                resolution: frameState.viewState.resolution,
                rotation: frameState.viewState.rotation,
                zoom: frameState.viewState.zoom,
              },
              pixelRatio: frameState.pixelRatio,
              size: frameState.size.slice(0),
              extent: frameState.extent.slice(0),
              coordinateToPixelTransform:
                frameState.coordinateToPixelTransform.slice(0),
              pixelToCoordinateTransform:
                frameState.pixelToCoordinateTransform.slice(0),
              layerStatesArray: frameState.layerStatesArray.map((l) => ({
                zIndex: l.zIndex,
                visible: l.visible,
                extent: l.extent,
                maxResolution: l.maxResolution,
                minResolution: l.minResolution,
                managed: l.managed,
              })),
            },
          });
        } else {
          frameState.animate = true;
        }
        return container;
      },
      source: new Source({
        attributions: [
          '<a href="https://www.maptiler.com/copyright/" target="_blank">© MapTiler</a>',
          '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>',
        ],
      }),
    }),
  ],
  target: 'map',
  view: new View({
    resolutions: createXYZ({tileSize: 512}).getResolutions(),
    center: [0, 0],
    zoom: 2,
  }),
});
map.addControl(new FullScreen());

let pointerOutside = true;
const mapTarget = map.getTargetElement();
mapTarget.addEventListener('pointerleave', () => {
  pointerOutside = true;
  showInfo([]);
});
map.on('pointermove', function (evt) {
  if (evt.dragging) {
    return;
  }
  pointerOutside = false;
  worker.postMessage({
    action: 'requestFeatures',
    pixel: evt.pixel,
  });
});

// Worker messaging and actions
worker.addEventListener('message', (message) => {
  if (message.data.action === 'loadImage') {
    // Image loader for ol-mapbox-style
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.addEventListener('load', function () {
      createImageBitmap(image, 0, 0, image.width, image.height).then(
        (imageBitmap) => {
          worker.postMessage(
            {
              action: 'imageLoaded',
              image: imageBitmap,
              src: message.data.src,
            },
            [imageBitmap],
          );
        },
      );
    });
    image.src = message.data.src;
  } else if (message.data.action === 'getFeatures') {
    showInfo(message.data.features);
  } else if (message.data.action === 'requestRender') {
    // Worker requested a new render frame
    map.render();
  } else if (canvas && message.data.action === 'rendered') {
    // Worker provides a new render frame
    requestAnimationFrame(function () {
      const imageData = message.data.imageData;
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      canvas.getContext('2d').drawImage(imageData, 0, 0);
      canvas.style.transform = message.data.transform;
      workerFrameState = message.data.frameState;
      updateContainerTransform();
    });
    rendering = false;
  }
});

const info = document.getElementById('info');
function showInfo(propertiesFromFeatures) {
  if (propertiesFromFeatures.length == 0 || pointerOutside) {
    info.innerText = '';
    info.style.opacity = '0';
    return;
  }
  const properties = propertiesFromFeatures.map((e) =>
    Object.keys(e)
      .filter((key) => !key.includes(':'))
      .reduce(
        (newObj, currKey) => ((newObj[currKey] = e[currKey]), newObj),
        {},
      ),
  );
  info.innerText = JSON.stringify(properties, null, 2);
  info.style.opacity = '1';
}
