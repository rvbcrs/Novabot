// Learn more https://docs.expo.dev/guides/monorepos/#metro-configuration
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// GLB modellen (objectherkenning 3D-viewer) worden als static assets gebundeld.
config.resolver.assetExts.push('glb');

module.exports = config;
