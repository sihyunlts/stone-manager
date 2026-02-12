#import <Foundation/Foundation.h>
#include <string.h>
#import <IOBluetooth/IOBluetooth.h>
#import <IOBluetooth/objc/IOBluetoothRFCOMMChannel.h>
#import <IOBluetooth/objc/IOBluetoothSDPServiceRecord.h>

#define BTLOG(fmt, ...) do { \
    NSLog((@"[STONE][BACK][BT] " fmt), ##__VA_ARGS__); \
} while(0)

extern void macos_bt_on_data(const uint8_t *data, size_t len);
extern void macos_bt_on_device_event(const char *address, int connected);

@interface StoneBluetoothManager : NSObject <IOBluetoothRFCOMMChannelDelegate>
@property (nonatomic, strong) IOBluetoothDevice *device;
@property (nonatomic, strong) IOBluetoothRFCOMMChannel *channel;
@property (nonatomic, copy) NSString *lastErrorContext;
@property (nonatomic, strong) IOBluetoothUserNotification *connectNotification;
@property (nonatomic, strong) NSMutableDictionary<NSString *, IOBluetoothUserNotification *> *disconnectNotifications;
@property (nonatomic, copy) NSString *sdpPendingAddress;
@property (nonatomic, assign) IOReturn sdpPendingStatus;
@property (nonatomic, assign) BOOL sdpPendingDone;
@property (nonatomic, assign) IOReturn rfcommPendingStatus;
@property (nonatomic, assign) BOOL rfcommPendingDone;
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

- (void)sdpQueryComplete:(IOBluetoothDevice *)device status:(IOReturn)status {
    NSString *addr = device.addressString ?: @"";
    @synchronized(self) {
        if (self.sdpPendingAddress &&
            [self.sdpPendingAddress caseInsensitiveCompare:addr] == NSOrderedSame) {
            self.sdpPendingDone = YES;
            self.sdpPendingStatus = status;
        }
    }
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
    // Cover devices that were already connected before app launch.
    for (IOBluetoothDevice *device in [IOBluetoothDevice pairedDevices]) {
        if ([device isConnected]) {
            [self registerDisconnectNotification:device];
        }
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
        // We can receive a delayed disconnect callback from a prior close while reconnect is already in progress.
        // In that case, avoid clearing current state with stale event data.
        if ([device isConnected]) {
            BTLOG(@"Disconnect callback ignored (still connected): %@", addr);
            return;
        }

        IOBluetoothUserNotification *existing = self.disconnectNotifications[addr];
        if (existing) {
            [existing unregister];
            [self.disconnectNotifications removeObjectForKey:addr];
        }
        // OS-level disconnect event arrived: clear stale local handles for this device.
        if (self.channel) {
            IOBluetoothDevice *channelDevice = [self.channel getDevice];
            NSString *channelAddr = channelDevice.addressString ?: @"";
            if (channelAddr.length == 0 || [channelAddr caseInsensitiveCompare:addr] == NSOrderedSame) {
                BTLOG(@"RFCOMM close");
                self.channel = nil;
            }
        }
        if (self.device) {
            NSString *currentAddr = self.device.addressString ?: @"";
            if ([currentAddr caseInsensitiveCompare:addr] == NSOrderedSame) {
                BTLOG(@"Link close: %@", addr);
                self.device = nil;
                BTLOG(@"Link disconnected: YES (%@)", addr);
            }
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

- (IOReturn)openRFCOMMChannel:(IOBluetoothDevice *)device
                    channelID:(BluetoothRFCOMMChannelID)channelID {
    const NSTimeInterval timeout = 3.0;
    @synchronized(self) {
        self.rfcommPendingDone = NO;
        self.rfcommPendingStatus = kIOReturnError;
    }

    __block IOReturn status = kIOReturnError;
    runOnMainSync(^{
        IOBluetoothRFCOMMChannel *openedChannel = nil;
        status = [device openRFCOMMChannelAsync:&openedChannel withChannelID:channelID delegate:self];
    });
    if (status != kIOReturnSuccess) {
        return status;
    }

    NSString *targetAddr = device.addressString ?: @"";
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while ([deadline timeIntervalSinceNow] > 0) {
        BOOL done = NO;
        IOReturn doneStatus = kIOReturnError;
        @synchronized(self) {
            done = self.rfcommPendingDone;
            doneStatus = self.rfcommPendingStatus;
        }
        if (done) {
            return doneStatus;
        }

        if (self.channel && [self.channel isOpen]) {
            IOBluetoothDevice *channelDevice = [self.channel getDevice];
            NSString *channelAddr = channelDevice.addressString ?: @"";
            if (channelAddr.length > 0 &&
                [channelAddr caseInsensitiveCompare:targetAddr] == NSOrderedSame) {
                return kIOReturnSuccess;
            }
        }
        [NSThread sleepForTimeInterval:0.05];
    }

    return kIOReturnTimeout;
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

- (IOReturn)refreshSDPForDevice:(IOBluetoothDevice *)device timeout:(NSTimeInterval)timeout {
    if (!device) {
        return kIOReturnBadArgument;
    }

    NSString *addr = device.addressString ?: @"";
    NSDate *prevUpdate = [device getLastServicesUpdate];

    @synchronized(self) {
        self.sdpPendingAddress = addr;
        self.sdpPendingStatus = kIOReturnError;
        self.sdpPendingDone = NO;
    }

    __block IOReturn kickStatus = kIOReturnError;
    runOnMainSync(^{
        kickStatus = [device performSDPQuery:self];
    });
    BTLOG(@"SDP query kick: status=%d (%@)", (int)kickStatus, addr);
    if (kickStatus != kIOReturnSuccess) {
        @synchronized(self) {
            self.sdpPendingAddress = nil;
            self.sdpPendingDone = NO;
        }
        return kickStatus;
    }

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while ([deadline timeIntervalSinceNow] > 0) {
        BOOL done = NO;
        IOReturn doneStatus = kIOReturnError;
        @synchronized(self) {
            done = self.sdpPendingDone &&
                self.sdpPendingAddress &&
                [self.sdpPendingAddress caseInsensitiveCompare:addr] == NSOrderedSame;
            doneStatus = self.sdpPendingStatus;
        }
        if (done) {
            @synchronized(self) {
                self.sdpPendingAddress = nil;
                self.sdpPendingDone = NO;
            }
            return doneStatus;
        }

        NSDate *currentUpdate = [device getLastServicesUpdate];
        BOOL hasFreshUpdate = currentUpdate && (!prevUpdate || [currentUpdate compare:prevUpdate] == NSOrderedDescending);
        if (hasFreshUpdate) {
            BTLOG(@"SDP updated by timestamp (%@)", addr);
            @synchronized(self) {
                self.sdpPendingAddress = nil;
                self.sdpPendingDone = NO;
            }
            return kIOReturnSuccess;
        }

        [NSThread sleepForTimeInterval:0.05];
    }

    @synchronized(self) {
        self.sdpPendingAddress = nil;
        self.sdpPendingDone = NO;
    }
    BTLOG(@"SDP query timeout (%@)", addr);
    return kIOReturnTimeout;
}

- (IOReturn)connectToAddress:(NSString *)address {
    [self ensureConnectionNotifications];
    const NSTimeInterval opTimeout = 3.0;
    if (self.device && address.length > 0) {
        if ([self.device.addressString caseInsensitiveCompare:address] != NSOrderedSame) {
            if (![self disconnectWithTimeout:opTimeout]) {
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

    if (self.channel && [self.channel isOpen]) {
        IOBluetoothDevice *channelDevice = [self.channel getDevice];
        NSString *channelAddr = channelDevice.addressString ?: @"";
        if (channelAddr.length > 0 &&
            [channelAddr caseInsensitiveCompare:address] == NSOrderedSame) {
            self.device = device;
            [self registerDisconnectNotification:device];
            self.lastErrorContext = @"rfcomm_already_open";
            BTLOG(@"Connect start: %@ (%@)", device.name, device.addressString);
            BTLOG(@"RFCOMM already open: %@", device.addressString);
            return kIOReturnSuccess;
        }

        BTLOG(@"RFCOMM open on different device: %@ -> %@, resetting", channelAddr, address);
        BOOL down = [self disconnectWithTimeout:opTimeout];
        BTLOG(@"Different-device reset: %@", down ? @"YES" : @"NO");
        if (!down) {
            self.lastErrorContext = @"disconnect_timeout";
            return kIOReturnBusy;
        }
    }

    self.device = device;
    [self registerDisconnectNotification:device];
    self.lastErrorContext = @"connect_start";
    BTLOG(@"Connect start: %@ (%@)", device.name, device.addressString);

    BOOL wasConnected = [device isConnected];

    if (wasConnected) {
        BTLOG(@"Already connected: %@", device.addressString);

        // First try attaching RFCOMM on the existing OS link.
        self.lastErrorContext = @"sdp_query_existing_link";
        IOReturn sdpExisting = [self refreshSDPForDevice:device timeout:opTimeout];
        if (sdpExisting == kIOReturnSuccess) {
            self.lastErrorContext = @"resolve_channel_existing_link";
            BluetoothRFCOMMChannelID existingCh = 0;
            NSDate *existingDeadline = [NSDate dateWithTimeIntervalSinceNow:opTimeout];
            while ([existingDeadline timeIntervalSinceNow] > 0) {
                existingCh = [self resolveRFCOMMChannel:device];
                if (existingCh != 0) {
                    break;
                }
                [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                         beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
            }

            if (existingCh != 0) {
                BTLOG(@"GAIA channel (existing link): %d", (int)existingCh);
                self.lastErrorContext = @"open_rfcomm_existing_link";
                BTLOG(@"Open RFCOMM (existing link): ch=%d", (int)existingCh);
                IOReturn existingStatus = [self openRFCOMMChannel:device channelID:existingCh];
                if (existingStatus == kIOReturnSuccess) {
                    self.lastErrorContext = @"connected";
                    BTLOG(@"RFCOMM connected (existing link): ch=%d", (int)existingCh);
                    return kIOReturnSuccess;
                }
                BTLOG(@"RFCOMM attach failed on existing link: ch=%d status=%d", (int)existingCh, (int)existingStatus);
            } else {
                BTLOG(@"GAIA channel (existing link): NOT FOUND");
            }
        } else {
            BTLOG(@"SDP refresh failed on existing link: status=%d", (int)sdpExisting);
        }

        BTLOG(@"Reset existing link before RFCOMM attach: %@", device.addressString);
        BOOL down = [self disconnectWithTimeout:opTimeout];
        BTLOG(@"Existing link reset: %@ (%@)", down ? @"YES" : @"NO", device.addressString);
        if (!down) {
            self.lastErrorContext = @"stale_disconnect_timeout";
            BTLOG(@"Existing link reset timeout: %@", device.addressString);
            return kIOReturnBusy;
        }
    }

    self.lastErrorContext = @"open_connection";
    IOReturn linkStatus = [device openConnection];
    BTLOG(@"Link request: status=%d", (int)linkStatus);
    BOOL linkUp = [self waitForDevice:device connected:YES timeout:opTimeout];
    BTLOG(@"Link connected: %@", linkUp ? @"YES" : @"NO");
    if (!linkUp) {
        self.lastErrorContext = @"link_connect_timeout";
        return kIOReturnTimeout;
    }

    self.lastErrorContext = @"sdp_query";
    IOReturn sdpKick = [self refreshSDPForDevice:device timeout:opTimeout];
    if (sdpKick != kIOReturnSuccess) {
        self.lastErrorContext = @"sdp_query_failed";
        BTLOG(@"SDP query failed: status=%d", (int)sdpKick);
        return sdpKick;
    }

    self.lastErrorContext = @"resolve_channel";
    BluetoothRFCOMMChannelID resolved = 0;
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:opTimeout];
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
    IOReturn status = [self openRFCOMMChannel:device channelID:resolved];
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

- (IOReturn)disconnect {
    BOOL down = [self disconnectWithTimeout:3.0];
    if (down) {
        self.device = nil;
        self.lastErrorContext = @"disconnected";
        return kIOReturnSuccess;
    }
    self.lastErrorContext = @"disconnect_timeout";
    return kIOReturnTimeout;
}

- (BOOL)disconnectWithTimeout:(NSTimeInterval)timeout {
    IOBluetoothRFCOMMChannel *channel = self.channel;
    IOBluetoothDevice *device = self.device;
    if (!device && channel) {
        device = [channel getDevice];
    }
    NSString *addr = device.addressString ?: @"";

    if (channel) {
        BTLOG(@"RFCOMM close");
        [channel closeChannel];
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
    @synchronized(self) {
        self.rfcommPendingDone = YES;
        self.rfcommPendingStatus = error;
    }
    if (error == kIOReturnSuccess) {
        self.channel = rfcommChannel;
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
            id connected = [device isConnected] ? (id)kCFBooleanTrue : (id)kCFBooleanFalse;
            if (address.length == 0) {
                continue;
            }
            IOBluetoothSDPUUID *gaiaUUID = [IOBluetoothSDPUUID uuidWithBytes:(const void *)(uint8_t[]){0x00, 0x00, 0x11, 0x07, 0xD1, 0x02, 0x11, 0xE1, 0x9B, 0x23, 0x00, 0x02, 0x5B, 0x00, 0xA5, 0xA5} length:16];
            IOBluetoothSDPServiceRecord *gaiaRecord = [device getServiceRecordForUUID:gaiaUUID];
            id hasGaia = gaiaRecord ? (id)kCFBooleanTrue : (id)kCFBooleanFalse;
            [entries addObject:@{ @"name": name, @"address": address, @"connected": connected, @"has_gaia": hasGaia }];
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
        link = [manager.device isConnected];
    }
    if (manager.channel) {
        rfcomm = [manager.channel isOpen];
    }

    NSDictionary *info = @{
        @"address": address,
        @"link": link ? (id)kCFBooleanTrue : (id)kCFBooleanFalse,
        @"rfcomm": rfcomm ? (id)kCFBooleanTrue : (id)kCFBooleanFalse
    };
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

int macos_bt_disconnect(void) {
    return (int)[[StoneBluetoothManager shared] disconnect];
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
