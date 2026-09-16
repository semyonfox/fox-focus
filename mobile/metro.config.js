const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// the app shares its row model and API clients with the web app in ../src
config.watchFolders = [path.resolve(__dirname, "../src")];

module.exports = config;
