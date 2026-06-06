//
//  ZekktrisCalls.m
//  Capacitor plugin registration shim.
//
//  WHERE THIS GOES: copy alongside ZekktrisCalls.swift into
//    apps/web/ios/App/App/  (after `npx cap add ios`), then
//    `cd apps/web/ios/App && pod install`.
//
//  Capacitor discovers the plugin automatically via this macro — you
//  do NOT call any register() method yourself. The plugin name
//  "ZekktrisCalls" here must match window.Capacitor.Plugins.ZekktrisCalls
//  used by apps/web/src/lib/native.ts.
//

#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(ZekktrisCallsPlugin, "ZekktrisCalls",
    CAP_PLUGIN_METHOD(presentIncomingCall, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(endCall, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(reportOutgoingCall, CAPPluginReturnPromise);
)
