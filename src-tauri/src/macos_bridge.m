#import <Foundation/Foundation.h>
#include <string.h>
#import <IOBluetooth/IOBluetooth.h>
#import <IOBluetooth/objc/IOBluetoothRFCOMMChannel.h>
#import <IOBluetooth/objc/IOBluetoothSDPServiceRecord.h>
#import <objc/runtime.h>

#define BTLOG(fmt, ...) do { \
    NSLog((@"[STONE][BACK][BT] " fmt), ##__VA_ARGS__); \
} while(0)

extern void macos_bt_on_data(const uint8_t *data, size_t len);

@interface StoneBluetoothManager : NSObject <IOBluetoothDeviceAsyncCallbacks, IOBluetoothRFCOMMChannelDelegate>
@property (nonatomic, strong) IOBluetoothDevice *device;
@property (nonatomic, strong) IOBluetoothRFCOMMChannel *channel;
@property (nonatomic, copy) NSString *lastErrorContext;
@end

@implementation StoneBluetoothManager

static void runOnMainSync(void (^block)(void)) {
    if ([NSThread isMainThread]) {
        block();
        return;
    }
    dispatch_sync(dispatch_get_main_queue(), block);
}

+ (instancetype)shared {
    static StoneBluetoothManager *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[StoneBluetoothManager alloc] init];
    });
    return instance;
}

- (void)connectionComplete:(IOBluetoothDevice *)device status:(IOReturn)status {}
- (void)remoteNameRequestComplete:(IOBluetoothDevice *)device status:(IOReturn)status {}

- (void)sdpQueryComplete:(IOBluetoothDevice *)device status:(IOReturn)status {
    (void)device;
    (void)status;
}

- (BOOL)waitForConnection:(IOBluetoothDevice *)device timeout:(NSTimeInterval)timeout {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (![device isConnected] && [deadline timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return [device isConnected];
}

- (BOOL)waitForDisconnection:(IOBluetoothDevice *)device timeout:(NSTimeInterval)timeout {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while ([device isConnected] && [deadline timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return ![device isConnected];
}

- (IOReturn)openRFCOMMChannelAndWait:(IOBluetoothDevice *)device
                           channelID:(BluetoothRFCOMMChannelID)channelID
                             timeout:(NSTimeInterval)timeout {
    __block IOReturn startStatus = kIOReturnError;
    __block dispatch_semaphore_t sema = dispatch_semaphore_create(0);
    __block IOBluetoothRFCOMMChannel *openedChannel = nil;
    __block IOReturn openStatus = kIOReturnError;

    runOnMainSync(^{
        startStatus = [device openRFCOMMChannelAsync:&openedChannel withChannelID:channelID delegate:self];
        if (startStatus != kIOReturnSuccess) {
            dispatch_semaphore_signal(sema);
        } else {
            // Store semaphore and temporary channel in associated objects.
            objc_setAssociatedObject(self, @"stone_rfcomm_sema", (id)sema, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            objc_setAssociatedObject(self, @"stone_rfcomm_channel", openedChannel, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
    });

    dispatch_time_t waitTime = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(sema, waitTime) != 0) {
        return kIOReturnTimeout;
    }

    NSNumber *statusObj = objc_getAssociatedObject(self, @"stone_rfcomm_status");
    if (statusObj) {
        openStatus = (IOReturn)statusObj.intValue;
    } else if (startStatus != kIOReturnSuccess) {
        openStatus = startStatus;
    }

    return openStatus;
}

- (BluetoothRFCOMMChannelID)resolveRFCOMMChannel:(IOBluetoothDevice *)device {
    BluetoothRFCOMMChannelID channelID = 0;

    IOBluetoothSDPUUID *gaiaUUID = [IOBluetoothSDPUUID uuidWithBytes:(const void *)(uint8_t[]){0x00, 0x00, 0x11, 0x07, 0xD1, 0x02, 0x11, 0xE1, 0x9B, 0x23, 0x00, 0x02, 0x5B, 0x00, 0xA5, 0xA5} length:16];
    IOBluetoothSDPServiceRecord *record = [device getServiceRecordForUUID:gaiaUUID];
    if (record && [record getRFCOMMChannelID:&channelID] == kIOReturnSuccess) {
        return channelID;
    }
    return 0;
}

- (IOReturn)connectToAddress:(NSString *)address {
    [self disconnect];

    IOBluetoothDevice *device = [IOBluetoothDevice deviceWithAddressString:address];
    if (!device) {
        for (IOBluetoothDevice *candidate in [IOBluetoothDevice pairedDevices]) {
            if ([[candidate addressString] caseInsensitiveCompare:address] == NSOrderedSame) {
                device = candidate;
                break;
            }
        }
    }

    if (!device) {
        self.lastErrorContext = @"device_not_found";
        BTLOG(@"Device not found: %@", address);
        return kIOReturnNotFound;
    }

    self.device = device;
    self.lastErrorContext = @"connect_start";
    BTLOG(@"Connect start: %@ (%@)", device.name, device.addressString);

    if ([device isConnected]) {
        self.lastErrorContext = @"wait_disconnect";
        BTLOG(@"Wait for disconnect: %@", device.addressString);
        [device closeConnection];
        BOOL down = [self waitForDisconnection:device timeout:2.0];
        BTLOG(@"Disconnect complete: %@", down ? @"YES" : @"NO");
        if (!down) {
            self.lastErrorContext = @"still_connected";
            return kIOReturnBusy;
        }
    }

    self.lastErrorContext = @"open_connection";
    IOReturn linkStatus = [device openConnection];
    BTLOG(@"Link request: status=%d", (int)linkStatus);
    BOOL linkUp = [self waitForConnection:device timeout:3.0];
    BTLOG(@"Link connected: %@", linkUp ? @"YES" : @"NO");

    NSMutableArray<NSNumber *> *candidates = [NSMutableArray array];
    self.lastErrorContext = @"sdp_query";
    IOReturn sdpKick = [device performSDPQuery:nil];
    BTLOG(@"SDP query kick: status=%d", (int)sdpKick);

    self.lastErrorContext = @"resolve_channel";
    BluetoothRFCOMMChannelID resolved = [self resolveRFCOMMChannel:device];

    if (resolved != 0) {
        [candidates addObject:@(resolved)];
        BTLOG(@"GAIA channel: %d", (int)resolved);
    } else {
        BTLOG(@"GAIA channel: NOT FOUND");
    }

    self.lastErrorContext = @"open_rfcomm_candidates";
    IOReturn status = kIOReturnError;
    for (NSNumber *candidate in candidates) {
        BluetoothRFCOMMChannelID cid = (BluetoothRFCOMMChannelID)candidate.unsignedCharValue;
        if (cid == 0) {
            continue;
        }
        BTLOG(@"Open RFCOMM: ch=%d", (int)cid);
        status = [self openRFCOMMChannelAndWait:device channelID:cid timeout:4.0];
        if (status == kIOReturnSuccess) {
            self.lastErrorContext = @"connected";
            BTLOG(@"RFCOMM connected: ch=%d", (int)cid);
            return kIOReturnSuccess;
        }
        BTLOG(@"RFCOMM open failed: ch=%d status=%d", (int)cid, (int)status);
    }

    self.lastErrorContext = @"open_rfcomm_failed";
    BTLOG(@"RFCOMM open failed: status=%d", (int)status);
    return status;
}

- (void)disconnect {
    IOBluetoothDevice *device = self.device;
    IOBluetoothRFCOMMChannel *channel = self.channel;
    NSString *addr = device.addressString;

    if (channel) {
        BTLOG(@"RFCOMM close");
        runOnMainSync(^{
            [channel closeChannel];
        });
        self.channel = nil;
    }
    if (device) {
        BTLOG(@"Link close: %@", addr);
        [device closeConnection];
        BOOL down = [self waitForDisconnection:device timeout:2.0];
        BTLOG(@"Link disconnected: %@ (%@)", down ? @"YES" : @"NO", addr ?: @"");
    }
    self.device = nil;
}

- (IOReturn)sendData:(NSData *)data {
    if (!self.channel || data.length == 0) {
        return kIOReturnNotOpen;
    }

    BluetoothRFCOMMMTU mtu = [self.channel getMTU];
    if (mtu == 0) {
        mtu = 127;
    }

    const uint8_t *bytes = data.bytes;
    NSUInteger remaining = data.length;
    while (remaining > 0) {
        UInt16 chunk = (UInt16)MIN(remaining, (NSUInteger)mtu);
        IOReturn status = [self.channel writeSync:(void *)bytes length:chunk];
        if (status != kIOReturnSuccess) {
            return status;
        }
        bytes += chunk;
        remaining -= chunk;
    }

    return kIOReturnSuccess;
}

- (void)rfcommChannelData:(IOBluetoothRFCOMMChannel *)rfcommChannel data:(void *)dataPointer length:(size_t)dataLength {
    if (dataPointer && dataLength > 0) {
        macos_bt_on_data((const uint8_t *)dataPointer, dataLength);
    }
}

- (void)rfcommChannelClosed:(IOBluetoothRFCOMMChannel *)rfcommChannel {
    self.channel = nil;
}

- (void)rfcommChannelOpenComplete:(IOBluetoothRFCOMMChannel *)rfcommChannel status:(IOReturn)error {
    if (error == kIOReturnSuccess) {
        self.channel = rfcommChannel;
    }
    objc_setAssociatedObject(self, @"stone_rfcomm_status", @(error), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    dispatch_semaphore_t sema = (dispatch_semaphore_t)objc_getAssociatedObject(self, @"stone_rfcomm_sema");
    if (sema) {
        dispatch_semaphore_signal(sema);
    }
}

@end

char *macos_bt_list_paired_devices(void) {
    __block char *result = NULL;
    void (^work)(void) = ^{
        NSMutableArray *entries = [NSMutableArray array];
        for (IOBluetoothDevice *device in [IOBluetoothDevice pairedDevices]) {
            NSString *name = device.name ?: @"(unknown)";
            NSString *address = device.addressString ?: @"";
            NSNumber *connected = @([device isConnected] ? YES : NO);
            if (address.length == 0) {
                continue;
            }
            [entries addObject:@{ @"name": name, @"address": address, @"connected": connected }];
        }

        NSError *error = nil;
        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:entries options:0 error:&error];
        if (!jsonData || error) {
            result = strdup("[]");
            return;
        }

        NSString *jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
        if (!jsonString) {
            result = strdup("[]");
            return;
        }

        result = strdup([jsonString UTF8String]);
    };

    if ([NSThread isMainThread]) {
        work();
    } else {
        dispatch_semaphore_t sema = dispatch_semaphore_create(0);
        dispatch_async(dispatch_get_main_queue(), ^{
            work();
            dispatch_semaphore_signal(sema);
        });
        dispatch_time_t waitTime = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC));
        if (dispatch_semaphore_wait(sema, waitTime) != 0) {
            return strdup("[]");
        }
    }

    if (!result) {
        return strdup("[]");
    }
    return result;
}

int macos_bt_connect(const char *address) {
    if (!address) {
        return (int)kIOReturnBadArgument;
    }
    NSString *addr = [NSString stringWithUTF8String:address];
    if (!addr) {
        return (int)kIOReturnBadArgument;
    }

    @try {
        IOReturn status = [[StoneBluetoothManager shared] connectToAddress:addr];
        return (int)status;
    } @catch (NSException *exception) {
        [StoneBluetoothManager shared].lastErrorContext = [NSString stringWithFormat:@"exception:%@", exception.name];
        return (int)kIOReturnError;
    }
}

void macos_bt_disconnect(void) {
    [[StoneBluetoothManager shared] disconnect];
}

int macos_bt_write(const uint8_t *data, size_t len) {
    if (!data || len == 0) {
        return (int)kIOReturnBadArgument;
    }
    NSData *payload = [NSData dataWithBytes:data length:len];
    __block IOReturn status = kIOReturnError;
    runOnMainSync(^{
        @try {
            status = [[StoneBluetoothManager shared] sendData:payload];
        } @catch (NSException *exception) {
            [StoneBluetoothManager shared].lastErrorContext = [NSString stringWithFormat:@"exception:%@", exception.name];
            status = kIOReturnError;
        }
    });
    return (int)status;
}

char *macos_bt_last_error_context(void) {
    NSString *context = [StoneBluetoothManager shared].lastErrorContext;
    if (!context || context.length == 0) {
        return strdup("");
    }
    return strdup([context UTF8String]);
}
