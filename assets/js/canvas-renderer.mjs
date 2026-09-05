export function createCanvasRenderer(player, { canvas, offscreenCanvas, getOverlays, clampPan }) {
  const { container, video } = player;
  const mainCtx = canvas.getContext('2d');
  const offscreenCtx = offscreenCanvas?.getContext('2d');
  let animationFrameId = null;
  let disposed = false;

  const listen = player.addListener || player.resources?.listen?.bind(player.resources);
  const cancelFrame = () => {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    player.animationFrameId = null;
  };
  const scheduleCanvasFrame = () => {
    if (disposed || !container.isConnected || player.disposed || video.paused) {
      animationFrameId = null;
      player.animationFrameId = null;
      return;
    }
    animationFrameId = requestAnimationFrame(() => {
      animationFrameId = null;
      player.animationFrameId = null;
      renderCanvas(getOverlays());
    });
    player.animationFrameId = animationFrameId;
  };

  function redrawCanvas() {
    if (!disposed && !animationFrameId && container.isConnected && !player.disposed) renderCanvas(getOverlays());
  }

  function renderCanvas(overlayState) {
    if (disposed || player.disposed || !container.isConnected) {
      cancelFrame();
      return;
    }

    const isBuffering = player.isBuffering;
    clampPan(container, canvas);
    let drawWidth, drawHeight, offsetX, offsetY;
    const actualCanvasWidth = canvas.width;
    const actualCanvasHeight = canvas.height;

    if (video.videoWidth > 0 && video.videoHeight > 0) {
      const canvasAspect = actualCanvasWidth / actualCanvasHeight;
      const videoAspect = video.videoWidth / video.videoHeight;
      if (canvasAspect > videoAspect) {
        drawHeight = actualCanvasHeight;
        drawWidth = drawHeight * videoAspect;
        offsetX = (actualCanvasWidth - drawWidth) / 2;
        offsetY = 0;
      } else {
        drawWidth = actualCanvasWidth;
        drawHeight = drawWidth / videoAspect;
        offsetX = 0;
        offsetY = (actualCanvasHeight - drawHeight) / 2;
      }
    } else {
      mainCtx.save();
      mainCtx.setTransform(1, 0, 0, 1, 0, 0);
      mainCtx.fillStyle = '#000';
      mainCtx.fillRect(0, 0, actualCanvasWidth, actualCanvasHeight);
      mainCtx.restore();
      scheduleCanvasFrame();
      return;
    }

    mainCtx.save();
    if (!isBuffering) {
      mainCtx.setTransform(1, 0, 0, 1, 0, 0);
      mainCtx.fillStyle = '#000';
      mainCtx.fillRect(0, 0, actualCanvasWidth, actualCanvasHeight);
    }

    const centerX = actualCanvasWidth / 2;
    const centerY = actualCanvasHeight / 2;
    mainCtx.translate(centerX, centerY);
    mainCtx.scale(container.zoomScale, container.zoomScale);
    mainCtx.translate(container.panX, container.panY);
    mainCtx.translate(-centerX, -centerY);

    try {
      if (!isBuffering) mainCtx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);

      const activeMasks = [];
      if (overlayState) {
        const isMaskReady = prefix => overlayState[`${prefix}_mask`] && overlayState[`img${prefix.charAt(0).toUpperCase() + prefix.slice(1)}Mask`]?.complete && overlayState[`img${prefix.charAt(0).toUpperCase() + prefix.slice(1)}Mask`].naturalWidth > 0;
        if (isMaskReady('jacks')) activeMasks.push(overlayState.imgJacksMask);
        if (isMaskReady('pp')) activeMasks.push(overlayState.imgPpMask);
        if (isMaskReady('hook')) activeMasks.push(overlayState.imgHookMask);
        if (isMaskReady('sharks')) activeMasks.push(overlayState.imgSharksMask);
        if (isMaskReady('ib')) activeMasks.push(overlayState.imgIbMask);
        if (isMaskReady('privates')) activeMasks.push(overlayState.imgPrivatesMask);
      }

      if (activeMasks.length > 0 && offscreenCtx) {
        if (!isBuffering) {
          if (offscreenCanvas.width !== actualCanvasWidth || offscreenCanvas.height !== actualCanvasHeight) {
            offscreenCanvas.width = actualCanvasWidth;
            offscreenCanvas.height = actualCanvasHeight;
          }
          offscreenCtx.save();
          offscreenCtx.clearRect(0, 0, actualCanvasWidth, actualCanvasHeight);
          offscreenCtx.globalCompositeOperation = 'source-over';
          activeMasks.forEach((maskImg, index) => {
            if (index > 0) offscreenCtx.globalCompositeOperation = 'lighter';
            offscreenCtx.drawImage(maskImg, offsetX, offsetY, drawWidth, drawHeight);
          });
          offscreenCtx.globalCompositeOperation = 'source-in';
          offscreenCtx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
          offscreenCtx.restore();
        }
        mainCtx.fillStyle = 'rgba(0,0,0,0.4)';
        mainCtx.fillRect(offsetX, offsetY, drawWidth, drawHeight);
        mainCtx.drawImage(offscreenCanvas, 0, 0, actualCanvasWidth, actualCanvasHeight, 0, 0, actualCanvasWidth, actualCanvasHeight);
      }

      if (overlayState) {
        const drawOverlay = prefix => {
          const minorImg = overlayState[`img${prefix.charAt(0).toUpperCase() + prefix.slice(1)}Minor`];
          const textImg = overlayState[`img${prefix.charAt(0).toUpperCase() + prefix.slice(1)}Text`];
          if (overlayState[`${prefix}_minor`] && minorImg?.complete && minorImg.naturalWidth > 0) mainCtx.drawImage(minorImg, offsetX, offsetY, drawWidth, drawHeight);
          if (overlayState[`${prefix}_text`] && textImg?.complete && textImg.naturalWidth > 0) mainCtx.drawImage(textImg, offsetX, offsetY, drawWidth, drawHeight);
        };
        ['jacks', 'pp', 'hook', 'sharks', 'ib', 'privates'].forEach(drawOverlay);
      }
    } catch (error) {
      console.error('Canvas Draw Error:', error);
      mainCtx.setTransform(1, 0, 0, 1, 0, 0);
      mainCtx.fillStyle = 'red';
      mainCtx.textAlign = 'center';
      mainCtx.fillText('Render Error', actualCanvasWidth / 2, actualCanvasHeight / 2);
    }
    mainCtx.restore();
    scheduleCanvasFrame();
  }

  listen(video, 'canplay', () => {
    if (!animationFrameId && container.isConnected) renderCanvas(getOverlays());
  });
  listen(video, 'play', () => { if (!animationFrameId) scheduleCanvasFrame(); });
  listen(video, 'pause', () => { cancelFrame(); redrawCanvas(); });
  listen(video, 'emptied', cancelFrame);
  listen(video, 'error', () => {
    cancelFrame();
    const ctx = mainCtx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'red';
    ctx.textAlign = 'center';
    ctx.font = '16px Arial';
    ctx.fillText('Video Error', canvas.width / 2, canvas.height / 2);
    ctx.restore();
  });

  const dispose = () => {
    disposed = true;
    cancelFrame();
  };
  if (player.resources?.own) player.resources.own(dispose);
  return { renderCanvas, redrawCanvas, scheduleCanvasFrame, dispose };
}
