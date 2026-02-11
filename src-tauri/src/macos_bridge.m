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
extern void macos_bt_on_device_event(const char *address, int connected);

@interface StoneBluetoothManager : NSObject <IOBluetoothDeviceAsyncCallbacks, IOBluetoothRFCOMMChannelDelegate>
@property (nonatomic, strong) IOBluetoothDevice *device;
@property (nonatomic, strong) IOBluetoothRFCOMMChannel *channel;
@property (nonatomic, copy) NSString *lastErrorContext;
@property (nonatomic, strong) IOBluetoothUserNotification *connectNotification;
@property (nonatomic, strong) NSMutableDictionary<NSString *, IOBluetoothUserNotification *> *disconnectNotifications;
@end

@implementation StoneBluetoothManager

static IOBluetoothDevice *findDeviceForAddress(NSString *address);

static void runOnMainSync(void (^block)(void)) {
    if ([NSThread isMainThread]) {
        block();
        return;
    }
    dispatch_sync(dispatch_get_main_queue(), block);
}

- (void)connectionComplete:(IOBluetoothDevice *)device status:(IOReturn)status {
    (void)device;
    (void)status;
}

- (void)remoteNameRequestComplete:(IOBluetoothDevice *)device status:(IOReturn)status {
    (void)device;
    (void)status;
}

- (void)sdpQueryComplete:(IOBluetoothDevice *)device status:(IOReturn)status {
    NSString *addr = device.addressString ?: @"";
    BTLOG(@"SDP query complete: status=%d (%@)", (int)status, addr);
    if (!device) {
        return;
    }
    NSArray *services = device.services;
    if (!services || services.count == 0) {
        BTLOG(@"SDP services: none (%@)", addr);
        return;
    }
    BTLOG(@"SDP services: %lu (%@)", (unsigned long)services.count, addr);
    for (IOBluetoothSDPServiceRecord *record in services) {
        NSString *name = [record getServiceName];
        if (!name || name.length == 0) {
            name = @"(unknown)";
        }
        BluetoothRFCOMMChannelID channelID = 0;
        IOReturn rfcommStatus = [record getRFCOMMChannelID:&channelID];
        if (rfcommStatus == kIOReturnSuccess) {
            BTLOG(@"SDP service: %@ (rfcomm=%d)", name, (int)channelID);
        } else {
            BTLOG(@"SDP service: %@ (rfcomm=none)", name);
        }
    }
}

+ (instancetype)shared {
    static StoneBluetoothManager *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[StoneBluetoothManager alloc] init];
    });
    return instance;
}

- (void)ensureConnectionNotifications {
    if (!self.connectNotification) {
        self.connectNotification = [IOBluetoothDevice registerForConnectNotifications:self selector:@selector(deviceConnected:device:)];
    }
    if (!self.disconnectNotifications) {
        self.disconnectNotifications = [NSMutableDictionary dictionary];
    }
}

- (void)registerDisconnectNotification:(IOBluetoothDevice *)device {
    NSString *addr = device.addressString ?: @"";
    if (addr.length == 0) {
        return;
    }
    if (self.disconnectNotifications[addr]) {
        return;
    }
    IOBluetoothUserNotification *note = [device registerForDisconnectNotification:self selector:@selector(deviceDisconnected:device:)];
    if (note) {
        self.disconnectNotifications[addr] = note;
    }
}

- (void)deviceConnected:(IOBluetoothUserNotification *)note device:(IOBluetoothDevice *)device {
    (void)note;
    if (!device) {
        return;
    }
    NSString *addr = device.addressString ?: @"";
    if (addr.length > 0) {
        [self registerDisconnectNotification:device];
        macos_bt_on_device_event([addr UTF8String], 1);
    }
}

- (void)deviceDisconnected:(IOBluetoothUserNotification *)note device:(IOBluetoothDevice *)device {
    (void)note;
    if (!device) {
        return;
    }
    NSString *addr = device.addressString ?: @"";
    if (addr.length > 0) {
        IOBluetoothUserNotification *existing = self.disconnectNotifications[addr];
        if (existing) {
            [existing unregister];
            [self.disconnectNotifications removeObjectForKey:addr];
        }
        macos_bt_on_device_event([addr UTF8String], 0);
    }
}

- (BOOL)waitForDevice:(IOBluetoothDevice *)device
            connected:(BOOL)connected
              timeout:(NSTimeInterval)timeout {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (([device isConnected] != connected) && [deadline timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return [device isConnected] == connected;
}

- (IOReturn)openRFCOMMChannelAndWait:(IOBluetoothDevice *)device
                           channelID:(BluetoothRFCOMMChannelID)channelID
                             timeout:(NSTimeInterval)timeout {
    (void)timeout;
    __block IOReturn status = kIOReturnError;
    __block IOBluetoothRFCOMMChannel *openedChannel = nil;

    runOnMainSync(^{
        status = [device openRFCOMMChannelSync:&openedChannel withChannelID:channelID delegate:self];
        if (status == kIOReturnSuccess) {
            self.channel = openedChannel;
        }
    });

    return status;
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
    [self ensureConnectionNotifications];
    if (self.device && address.length > 0) {
        if ([self.device.addressString caseInsensitiveCompare:address] != NSOrderedSame) {
            if (![self disconnectWithTimeout:4.0]) {
                self.lastErrorContext = @"disconnect_timeout";
                BTLOG(@"Disconnect timeout before connect");
                return kIOReturnBusy;
            }
        }
    }

    IOBluetoothDevice *device = findDeviceForAddress(address);

    if (!device) {
        self.lastErrorContext = @"device_not_found";
        BTLOG(@"Device not found: %@", address);
        return kIOReturnNotFound;
    }

    self.device = device;
    [self registerDisconnectNotification:device];
    self.lastErrorContext = @"connect_start";
    BTLOG(@"Connect start: %@ (%@)", device.name, device.addressString);

    if (self.channel && [self.channel isOpen] &&
        [self.device.addressString caseInsensitiveCompare:address] == NSOrderedSame) {
        self.lastErrorContext = @"rfcomm_already_open";
        BTLOG(@"RFCOMM already open: %@", device.addressString);
        return kIOReturnSuccess;
    }

    BOOL wasConnected = [device isConnected];
    if (wasConnected) {
        self.lastErrorContext = @"already_connected";
        BTLOG(@"Already connected: %@", device.addressString);
    }

    self.lastErrorContext = @"open_connection";
    IOReturn linkStatus = [device openConnection];
    BTLOG(@"Link request: status=%d", (int)linkStatus);
    BOOL linkUp = [self waitForDevice:device connected:YES timeout:3.0];
    BTLOG(@"Link connected: %@", linkUp ? @"YES" : @"NO");

    self.lastErrorContext = @"sdp_query";
    IOReturn sdpKick = [device performSDPQuery:nil];
    BTLOG(@"SDP query kick: status=%d", (int)sdpKick);

    self.lastErrorContext = @"resolve_channel";
    BluetoothRFCOMMChannelID resolved = 0;
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3.0];
    while ([deadline timeIntervalSinceNow] > 0) {
        resolved = [self resolveRFCOMMChannel:device];
        if (resolved != 0) {
            break;
        }
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }

    if (resolved != 0) {
        BTLOG(@"GAIA channel: %d", (int)resolved);
    } else {
        BTLOG(@"GAIA channel: NOT FOUND");
        self.lastErrorContext = @"gaia_not_found";
        return kIOReturnNotFound;
    }

    self.lastErrorContext = @"open_rfcomm";
    BTLOG(@"Open RFCOMM: ch=%d", (int)resolved);
    IOReturn status = [self openRFCOMMChannelAndWait:device channelID:resolved timeout:4.0];
    if (status == kIOReturnSuccess) {
        self.lastErrorContext = @"connected";
        BTLOG(@"RFCOMM connected: ch=%d", (int)resolved);
        return kIOReturnSuccess;
    }
    BTLOG(@"RFCOMM open failed: ch=%d status=%d", (int)resolved, (int)status);

    self.lastErrorContext = @"open_rfcomm_failed";
    BTLOG(@"RFCOMM open failed: status=%d", (int)status);
    return status;
}

- (void)disconnect {
    [self disconnectWithTimeout:2.0];
    self.device = nil;
}

- (BOOL)disconnectWithTimeout:(NSTimeInterval)timeout {
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
        BOOL down = [self waitForDevice:device connected:NO timeout:timeout];
        BTLOG(@"Link disconnected: %@ (%@)", down ? @"YES" : @"NO", addr ?: @"");
        return down;
    }
    return YES;
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

static IOBluetoothDevice *findDeviceForAddress(NSString *address) {
    if (!address || address.length == 0) {
        return nil;
    }
    IOBluetoothDevice *device = [IOBluetoothDevice deviceWithAddressString:address];
    if (device) {
        return device;
    }
    for (IOBluetoothDevice *candidate in [IOBluetoothDevice pairedDevices]) {
        if ([[candidate addressString] caseInsensitiveCompare:address] == NSOrderedSame) {
            return candidate;
        }
    }
    return nil;
}

char *macos_bt_list_paired_devices(void) {
    __block char *result = NULL;
    void (^work)(void) = ^{
        [[StoneBluetoothManager shared] ensureConnectionNotifications];
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

int macos_bt_sdp_query(const char *address) {
    if (!address) {
        return (int)kIOReturnBadArgument;
    }
    NSString *addr = [NSString stringWithUTF8String:address];
    if (!addr || addr.length == 0) {
        return (int)kIOReturnBadArgument;
    }

    __block IOReturn status = kIOReturnError;
    runOnMainSync(^{
        @try {
            IOBluetoothDevice *device = findDeviceForAddress(addr);
            if (!device) {
                [StoneBluetoothManager shared].lastErrorContext = @"device_not_found";
                BTLOG(@"SDP device not found: %@", addr);
                status = kIOReturnNotFound;
                return;
            }
            [StoneBluetoothManager shared].device = device;
            status = [device performSDPQuery:[StoneBluetoothManager shared]];
            BTLOG(@"SDP query kick: status=%d (%@)", (int)status, addr);
        } @catch (NSException *exception) {
            [StoneBluetoothManager shared].lastErrorContext = [NSString stringWithFormat:@"exception:%@", exception.name];
            status = kIOReturnError;
        }
    });
    return (int)status;
}

char *macos_bt_get_connection_info(void) {
    StoneBluetoothManager *manager = [StoneBluetoothManager shared];
    NSString *address = @"";
    BOOL link = NO;
    BOOL rfcomm = NO;

    if (manager.device) {
        address = manager.device.addressString ?: @"";
        link = [manager.device isConnected] ? YES : NO;
    }
    if (manager.channel) {
        rfcomm = [manager.channel isOpen];
    }

    NSDictionary *info = @{ @"address": address, @"link": @(link), @"rfcomm": @(rfcomm) };
    NSError *error = nil;
    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:info options:0 error:&error];
    if (!jsonData || error) {
        return strdup("{\"address\":\"\",\"link\":false,\"rfcomm\":false}");
    }
    NSString *jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    if (!jsonString) {
        return strdup("{\"address\":\"\",\"link\":false,\"rfcomm\":false}");
    }
    return strdup([jsonString UTF8String]);
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
