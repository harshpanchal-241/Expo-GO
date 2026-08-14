import React from "react";
import { Platform } from "react-native";
import AppAndroid from "./App.android.js";
import AppIOS from "./App.ios.js";

export default function App() {
  if (Platform.OS === "ios") {
    return <AppIOS />;
  }
  return <AppAndroid />;
}
