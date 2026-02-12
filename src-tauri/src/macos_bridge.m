#import <Foundation/Foundation.h>
#import <IOBluetooth/IOBluetooth.h>
#import <IOBluetooth/IOBluetoothTypes.h>
#import <IOBluetooth/objc/IOBluetoothRFCOMMChannel.h>
#import <IOBluetooth/objc/IOBluetoothSDPServiceRecord.h>

#define BTLOG(fmt, ...)                                                                                 \
    do {                                                                                               \
        NSLog((@"[STONE][BACK][BT] " fmt), ##__VA_ARGS__);                                            \
    } while (0)

extern void macos_bt_on_data(const uint8_t *data, size_t len);
extern void macos_bt_on_device_event(const char *address, int connected);

static IOBluetoothDevice *findDeviceForAddress(NSString *address);
static const NSTimeInterval kStoneOpTimeout = 10.0;

static void runOnMainSync(void (^block)(void)) {
    if ([NSThread isMainThread]) {
        block();
        return;
    }
    dispatch_sync(dispatch_get_main_queue(), block);
}

static NSString *normalizedAddress(NSString *address) {
    if (!address) {
        return @"";
    }
    return [[address lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

static id jsonBool(BOOL value) {
    return value ? (id)kCFBooleanTrue : (id)kCFBooleanFalse;
}

static IOBluetoothSDPUUID *stoneGaiaSDPUUID(void) {
    static IOBluetoothSDPUUID *uuid = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        const uint8_t bytes[] = {0x00, 0x00, 0x11, 0x07, 0xD1, 0x02, 0x11, 0xE1,
                                 0x9B, 0x23, 0x00, 0x02, 0x5B, 0x00, 0xA5, 0xA5};
        uuid = [IOBluetoothSDPUUID uuidWithBytes:bytes length:sizeof(bytes)];
    });
    return uuid;
}

static char *jsonCStringFromObject(id object, const char *fallbackJson) {
    NSError *error = nil;
    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
    if (!jsonData || error) {
        return strdup(fallbackJson);
    }
    NSString *jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    if (!jsonString) {
        return strdup(fallbackJson);
    }
    return strdup([jsonString UTF8String]);
}

@interface StoneDeviceInquiryCollector : NSObject <IOBluetoothDeviceInquiryDelegate>
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *entriesByAddress;
@property (nonatomic, assign) BOOL completed;
@property (nonatomic, strong) dispatch_semaphore_t doneSemaphore;
@end

@interface StoneBluetoothManager : NSObject <IOBluetoothRFCOMMChannelDelegate>
@property (nonatomic, strong) IOBluetoothDevice *device;
@property (nonatomic, strong) IOBluetoothRFCOMMChannel *channel;
@property (nonatomic, copy) NSString *lastErrorContext;
@property (nonatomic, strong) IOBluetoothUserNotification *connectNotification;
@property (nonatomic, strong) NSMutableDictionary<NSString *, IOBluetoothUserNotification *> *disconnectNotifications;

@property (nonatomic, strong) IOBluetoothDeviceInquiry *scanInquiry;
@property (nonatomic, strong) StoneDeviceInquiryCollector *scanCollector;

@property (nonatomic, copy) NSString *pendingSDPAddress;
@property (nonatomic, assign) BOOL pendingSDPDone;
@property (nonatomic, assign) IOReturn pendingSDPStatus;
@end

@implementation StoneDeviceInquiryCollector

- (instancetype)init {
    self = [super init];
    if (self) {
        _entriesByAddress = [NSMutableDictionary dictionary];
        _completed = NO;
    }
    return self;
}

- (void)addCandidate:(IOBluetoothDevice *)device {
    if (!device || [device isPaired]) {
        return;
    }

    NSString *address = device.addressString ?: @"";
    if (address.length == 0) {
        return;
    }

    NSString *name = device.name ?: @"";
    if (![[name uppercaseString] containsString:@"STONE"]) {
        return;
    }

    NSString *key = normalizedAddress(address);
    self.entriesByAddress[key] = @{
        @"name" : (name.length > 0 ? name : @"(unknown)"),
        @"address" : address,
        @"connected" : jsonBool([device isConnected]),
        @"has_gaia" : jsonBool(NO),
        @"paired" : jsonBool(NO)
    };
}

- (void)deviceInquiryDeviceFound:(IOBluetoothDeviceInquiry *)sender device:(IOBluetoothDevice *)device {
    (void)sender;
    [self addCandidate:device];
}

- (void)deviceInquiryDeviceNameUpdated:(IOBluetoothDeviceInquiry *)sender
                                device:(IOBluetoothDevice *)device
                      devicesRemaining:(uint32_t)devicesRemaining {
    (void)sender;
    (void)devicesRemaining;
    [self addCandidate:device];
}

- (void)deviceInquiryComplete:(IOBluetoothDeviceInquiry *)sender error:(IOReturn)error aborted:(BOOL)aborted {
    (void)sender;
    (void)aborted;
    (void)error;
    self.completed = YES;
    if (self.doneSemaphore) {
        dispatch_semaphore_signal(self.doneSemaphore);
    }
}

@end

@implementation StoneBluetoothManager

+ (instancetype)shared {
    static StoneBluetoothManager *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[StoneBluetoothManager alloc] init];
    });
    return instance;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _disconnectNotifications = [NSMutableDictionary dictionary];
        _pendingSDPDone = NO;
        _pendingSDPStatus = kIOReturnError;
        _lastErrorContext = @"";
    }
    return self;
}

- (void)ensureConnectionNotifications {
    if (!self.connectNotification) {
        self.connectNotification = [IOBluetoothDevice registerForConnectNotifications:self
                                                                             selector:@selector(deviceConnected:device:)];
    }

    if (!self.disconnectNotifications) {
        self.disconnectNotifications = [NSMutableDictionary dictionary];
    }

    NSArray *paired = [IOBluetoothDevice pairedDevices] ?: @[];
    for (IOBluetoothDevice *pairedDevice in paired) {
        if ([pairedDevice isConnected]) {
            [self registerDisconnectNotification:pairedDevice];
        }
    }
}

- (void)stopActiveInquiryIfNeeded {
    runOnMainSync(^{
        if (self.scanInquiry) {
            BTLOG(@"Stop active inquiry before connect");
            (void)[self.scanInquiry stop];
            self.scanInquiry = nil;
            self.scanCollector = nil;
        }
    });
}

- (void)registerDisconnectNotification:(IOBluetoothDevice *)device {
    if (!device) {
        return;
    }

    NSString *address = device.addressString ?: @"";
    if (address.length == 0) {
        return;
    }

    NSString *key = normalizedAddress(address);
    if (self.disconnectNotifications[key]) {
        return;
    }

    IOBluetoothUserNotification *note =
        [device registerForDisconnectNotification:self selector:@selector(deviceDisconnected:device:)];
    if (note) {
        self.disconnectNotifications[key] = note;
    }
}

- (void)unregisterDisconnectNotificationForAddress:(NSString *)address {
    NSString *key = normalizedAddress(address);
    if (key.length == 0) {
        return;
    }

    IOBluetoothUserNotification *note = self.disconnectNotifications[key];
    if (note) {
        [note unregister];
        [self.disconnectNotifications removeObjectForKey:key];
    }
}

- (BOOL)waitForDevice:(IOBluetoothDevice *)device connected:(BOOL)connected timeout:(NSTimeInterval)timeout {
    if (!device) {
        return NO;
    }

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (([device isConnected] != connected) && [deadline timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return [device isConnected] == connected;
}

- (BOOL)disconnectCurrentSessionWithTimeout:(NSTimeInterval)timeout {
    IOBluetoothRFCOMMChannel *currentChannel = self.channel;
    IOBluetoothDevice *currentDevice = self.device;

    if (!currentDevice && currentChannel) {
        currentDevice = [currentChannel getDevice];
    }

    NSString *address = currentDevice.addressString ?: @"";

    if (currentChannel) {
        BTLOG(@"RFCOMM close (%@)", address);
        [currentChannel closeChannel];
        self.channel = nil;
    }

    BOOL linkDown = YES;
    if (currentDevice && [currentDevice isConnected]) {
        BTLOG(@"Link close request: %@", address);
        IOReturn closeStatus = [currentDevice closeConnection];
        BTLOG(@"Link close status: %d (%@)", (int)closeStatus, address);
        linkDown = [self waitForDevice:currentDevice connected:NO timeout:timeout];
        BTLOG(@"Link disconnected: %@ (%@)", linkDown ? @"YES" : @"NO", address);
    }

    if (address.length > 0) {
        [self unregisterDisconnectNotificationForAddress:address];
    }

    self.device = nil;
    return linkDown;
}

- (IOReturn)performSDPQueryAndWait:(IOBluetoothDevice *)device timeout:(NSTimeInterval)timeout {
    if (!device) {
        return kIOReturnBadArgument;
    }

    NSString *address = device.addressString ?: @"";
    NSString *key = normalizedAddress(address);

    @synchronized(self) {
        self.pendingSDPAddress = key;
        self.pendingSDPDone = NO;
        self.pendingSDPStatus = kIOReturnError;
    }

    NSDate *prevUpdate = [device getLastServicesUpdate];
    NSArray *uuids = @[ stoneGaiaSDPUUID() ];
    __block IOReturn kickStatus = kIOReturnError;
    runOnMainSync(^{
        kickStatus = [device performSDPQuery:self uuids:uuids];
    });
    BTLOG(@"SDP query kick: status=%d (%@)", (int)kickStatus, address);
    if (kickStatus != kIOReturnSuccess) {
        @synchronized(self) {
            self.pendingSDPAddress = nil;
            self.pendingSDPDone = NO;
        }
        return kickStatus;
    }

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while ([deadline timeIntervalSinceNow] > 0) {
        BOOL done = NO;
        IOReturn doneStatus = kIOReturnError;

        @synchronized(self) {
            done = self.pendingSDPDone && self.pendingSDPAddress &&
                   [self.pendingSDPAddress isEqualToString:key];
            doneStatus = self.pendingSDPStatus;
        }

        if (done) {
            @synchronized(self) {
                self.pendingSDPAddress = nil;
                self.pendingSDPDone = NO;
            }
            return doneStatus;
        }

        NSDate *currentUpdate = [device getLastServicesUpdate];
        BOOL hasFreshUpdate =
            currentUpdate &&
            (!prevUpdate || [currentUpdate compare:prevUpdate] == NSOrderedDescending);
        if (hasFreshUpdate) {
            BluetoothRFCOMMChannelID channelID = [self resolveGaiaChannelID:device];
            if (channelID != 0) {
                BTLOG(@"SDP verified by services update (%@, ch=%d)", address, (int)channelID);
                @synchronized(self) {
                    self.pendingSDPAddress = nil;
                    self.pendingSDPDone = NO;
                }
                return kIOReturnSuccess;
            }
        }

        [NSThread sleepForTimeInterval:0.05];
    }

    // Guard against a race where completion is posted right as timeout expires.
    @synchronized(self) {
        BOOL done = self.pendingSDPDone && self.pendingSDPAddress &&
                    [self.pendingSDPAddress isEqualToString:key];
        if (done) {
            IOReturn doneStatus = self.pendingSDPStatus;
            self.pendingSDPAddress = nil;
            self.pendingSDPDone = NO;
            return doneStatus;
        }

        BluetoothRFCOMMChannelID fallbackChannel = [self resolveGaiaChannelID:device];
        if (fallbackChannel != 0) {
            BTLOG(@"SDP timeout fallback: using known GAIA channel (%@, ch=%d)", address, (int)fallbackChannel);
            self.pendingSDPAddress = nil;
            self.pendingSDPDone = NO;
            return kIOReturnSuccess;
        }

        self.pendingSDPAddress = nil;
        self.pendingSDPDone = NO;
    }

    BTLOG(@"SDP query timeout (%@)", address);
    return kIOReturnTimeout;
}

- (IOReturn)ensureLinkConnected:(IOBluetoothDevice *)device timeout:(NSTimeInterval)timeout {
    if (!device) {
        return kIOReturnBadArgument;
    }

    if ([device isConnected]) {
        BTLOG(@"Link already connected (%@)", device.addressString ?: @"");
        return kIOReturnSuccess;
    }

    self.lastErrorContext = @"open_connection";
    IOReturn linkStatus = [device openConnection];
    BTLOG(@"Link request: status=%d (%@)", (int)linkStatus, device.addressString ?: @"");

    if (linkStatus != kIOReturnSuccess && linkStatus != kIOBluetoothConnectionAlreadyExists) {
        if (![device isConnected]) {
            self.lastErrorContext = @"open_connection_failed";
            return linkStatus;
        }
    }

    BOOL linkUp = [self waitForDevice:device connected:YES timeout:timeout];
    BTLOG(@"Link connected: %@ (%@)", linkUp ? @"YES" : @"NO", device.addressString ?: @"");
    if (!linkUp) {
        self.lastErrorContext = @"link_connect_timeout";
        return kIOReturnTimeout;
    }

    return kIOReturnSuccess;
}

- (IOReturn)ensureAuthenticatedIfNeeded:(IOBluetoothDevice *)device timeout:(NSTimeInterval)timeout {
    if (!device) {
        return kIOReturnBadArgument;
    }
    if ([device isPaired]) {
        return kIOReturnSuccess;
    }

    self.lastErrorContext = @"request_authentication";
    BTLOG(@"Device is not paired, requesting authentication (%@)", device.addressString ?: @"");

    __block IOReturn authStatus = kIOReturnError;
    runOnMainSync(^{
        authStatus = [device requestAuthentication];
    });
    BTLOG(@"Authentication result: status=%d paired=%@", (int)authStatus, [device isPaired] ? @"YES" : @"NO");

    if (authStatus == kIOReturnSuccess && [device isPaired]) {
        return kIOReturnSuccess;
    }

    // Give the system pairing flow a short grace window.
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while ([deadline timeIntervalSinceNow] > 0) {
        if ([device isPaired]) {
            return kIOReturnSuccess;
        }
        [NSThread sleepForTimeInterval:0.05];
    }

    if ([device isPaired]) {
        return kIOReturnSuccess;
    }
    self.lastErrorContext = @"authentication_failed";
    return authStatus != kIOReturnSuccess ? authStatus : kIOReturnNotPermitted;
}

- (BluetoothRFCOMMChannelID)resolveGaiaChannelID:(IOBluetoothDevice *)device {
    if (!device) {
        return 0;
    }

    IOBluetoothSDPServiceRecord *record = [device getServiceRecordForUUID:stoneGaiaSDPUUID()];
    if (!record) {
        return 0;
    }

    BluetoothRFCOMMChannelID channelID = 0;
    IOReturn status = [record getRFCOMMChannelID:&channelID];
    if (status != kIOReturnSuccess) {
        return 0;
    }

    return channelID;
}

- (IOReturn)openGaiaRFCOMMChannel:(IOBluetoothDevice *)device
                        channelID:(BluetoothRFCOMMChannelID)channelID {
    if (!device || channelID == 0) {
        return kIOReturnBadArgument;
    }

    __block IOBluetoothRFCOMMChannel *openedChannel = nil;
    __block IOReturn status = kIOReturnError;
    runOnMainSync(^{
        status = [device openRFCOMMChannelSync:&openedChannel withChannelID:channelID delegate:self];
    });
    if (status != kIOReturnSuccess) {
        return status;
    }

    self.channel = openedChannel;
    return kIOReturnSuccess;
}

- (IOReturn)attachGaiaRFCOMMForDevice:(IOBluetoothDevice *)device timeout:(NSTimeInterval)timeout {
    self.lastErrorContext = @"sdp_query";
    IOReturn sdpStatus = [self performSDPQueryAndWait:device timeout:timeout];
    if (sdpStatus != kIOReturnSuccess) {
        self.lastErrorContext = @"sdp_query_failed";
        return sdpStatus;
    }

    self.lastErrorContext = @"resolve_gaia_channel";
    BluetoothRFCOMMChannelID channelID = [self resolveGaiaChannelID:device];
    if (channelID == 0) {
        self.lastErrorContext = @"gaia_channel_not_found";
        BTLOG(@"GAIA channel not found (%@)", device.addressString ?: @"");
        return kIOReturnNotFound;
    }

    if (self.channel) {
        [self.channel closeChannel];
        self.channel = nil;
    }

    self.lastErrorContext = @"open_rfcomm";
    BTLOG(@"Open RFCOMM: ch=%d (%@)", (int)channelID, device.addressString ?: @"");
    IOReturn rfcommStatus = [self openGaiaRFCOMMChannel:device channelID:channelID];
    if (rfcommStatus != kIOReturnSuccess) {
        BTLOG(@"RFCOMM open failed on ch=%d: status=%d (%@)", (int)channelID, (int)rfcommStatus, device.addressString ?: @"");

        // Match original Android fallback behavior (direct channel 1).
        if (channelID != 1) {
            BTLOG(@"RFCOMM fallback try: ch=1 (%@)", device.addressString ?: @"");
            IOReturn fallbackStatus = [self openGaiaRFCOMMChannel:device channelID:1];
            if (fallbackStatus == kIOReturnSuccess) {
                BTLOG(@"RFCOMM fallback success on ch=1 (%@)", device.addressString ?: @"");
                return kIOReturnSuccess;
            }
            BTLOG(@"RFCOMM fallback failed on ch=1: status=%d (%@)", (int)fallbackStatus, device.addressString ?: @"");
            rfcommStatus = fallbackStatus;
        }

        self.lastErrorContext = @"open_rfcomm_failed";
        return rfcommStatus;
    }

    return kIOReturnSuccess;
}

- (IOReturn)connectToAddress:(NSString *)address {
    [self ensureConnectionNotifications];
    [self stopActiveInquiryIfNeeded];

    NSString *targetAddress = normalizedAddress(address);
    if (targetAddress.length == 0) {
        self.lastErrorContext = @"invalid_address";
        return kIOReturnBadArgument;
    }

    const NSTimeInterval timeout = kStoneOpTimeout;

    if (self.channel && [self.channel isOpen]) {
        IOBluetoothDevice *channelDevice = [self.channel getDevice];
        NSString *channelAddress = normalizedAddress(channelDevice.addressString ?: @"");

        if (channelAddress.length > 0 && [channelAddress isEqualToString:targetAddress]) {
            self.device = channelDevice ?: self.device;
            [self registerDisconnectNotification:self.device];
            self.lastErrorContext = @"already_connected";
            BTLOG(@"RFCOMM already open (%@)", channelAddress);
            return kIOReturnSuccess;
        }

        self.lastErrorContext = @"disconnect_stale_session";
        BTLOG(@"Reset stale RFCOMM session: %@ -> %@", channelAddress, targetAddress);
        if (![self disconnectCurrentSessionWithTimeout:timeout]) {
            self.lastErrorContext = @"disconnect_timeout";
            return kIOReturnTimeout;
        }
    }

    if (self.device) {
        NSString *currentAddress = normalizedAddress(self.device.addressString ?: @"");
        if (currentAddress.length > 0 && ![currentAddress isEqualToString:targetAddress]) {
            self.lastErrorContext = @"disconnect_previous_device";
            BTLOG(@"Reset previous device session: %@ -> %@", currentAddress, targetAddress);
            if (![self disconnectCurrentSessionWithTimeout:timeout]) {
                self.lastErrorContext = @"disconnect_timeout";
                return kIOReturnTimeout;
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

    BOOL hadExistingLink = [device isConnected];
    IOReturn linkStatus = [self ensureLinkConnected:device timeout:timeout];
    if (linkStatus != kIOReturnSuccess) {
        return linkStatus;
    }

    IOReturn authStatus = [self ensureAuthenticatedIfNeeded:device timeout:timeout];
    if (authStatus != kIOReturnSuccess) {
        return authStatus;
    }

    IOReturn attachStatus = [self attachGaiaRFCOMMForDevice:device timeout:timeout];
    if (attachStatus != kIOReturnSuccess && hadExistingLink) {
        // App restart can leave a stale baseband link; reset once and retry.
        self.lastErrorContext = @"retry_after_link_reset";
        BTLOG(@"Attach failed on existing link: status=%d (%@). Resetting link once.",
              (int)attachStatus,
              device.addressString ?: @"");

        BOOL down = [self disconnectCurrentSessionWithTimeout:timeout];
        BTLOG(@"Link reset result: %@ (%@)", down ? @"YES" : @"NO", device.addressString ?: @"");
        if (!down) {
            self.lastErrorContext = @"disconnect_timeout";
            return kIOReturnTimeout;
        }

        self.device = device;
        [self registerDisconnectNotification:device];

        IOReturn reopenStatus = [self ensureLinkConnected:device timeout:timeout];
        if (reopenStatus != kIOReturnSuccess) {
            return reopenStatus;
        }

        attachStatus = [self attachGaiaRFCOMMForDevice:device timeout:timeout];
    }

    if (attachStatus != kIOReturnSuccess) {
        return attachStatus;
    }

    self.lastErrorContext = @"connected";
    BTLOG(@"RFCOMM connected (%@)", device.addressString ?: @"");
    return kIOReturnSuccess;
}

- (IOReturn)disconnect {
    BOOL down = [self disconnectCurrentSessionWithTimeout:3.0];
    if (down) {
        self.lastErrorContext = @"disconnected";
        return kIOReturnSuccess;
    }

    self.lastErrorContext = @"disconnect_timeout";
    return kIOReturnTimeout;
}

- (IOReturn)sendData:(NSData *)data {
    if (!data || data.length == 0) {
        return kIOReturnBadArgument;
    }
    if (!self.channel || ![self.channel isOpen]) {
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

- (NSDictionary *)currentConnectionInfo {
    IOBluetoothDevice *device = self.device;
    if (!device && self.channel) {
        device = [self.channel getDevice];
    }

    NSString *address = @"";
    BOOL link = NO;
    BOOL rfcomm = NO;

    if (device) {
        address = device.addressString ?: @"";
        link = [device isConnected];
    }

    if (self.channel) {
        rfcomm = [self.channel isOpen];
    }

    return @{
        @"address" : address,
        @"link" : jsonBool(link),
        @"rfcomm" : jsonBool(rfcomm)
    };
}

- (void)deviceConnected:(IOBluetoothUserNotification *)note device:(IOBluetoothDevice *)device {
    (void)note;
    if (!device) {
        return;
    }

    NSString *address = device.addressString ?: @"";
    if (address.length == 0) {
        return;
    }

    [self registerDisconnectNotification:device];
    macos_bt_on_device_event([address UTF8String], 1);
}

- (void)deviceDisconnected:(IOBluetoothUserNotification *)note device:(IOBluetoothDevice *)device {
    (void)note;
    if (!device) {
        return;
    }

    NSString *address = device.addressString ?: @"";
    NSString *addressKey = normalizedAddress(address);
    if (addressKey.length == 0) {
        return;
    }

    if ([device isConnected]) {
        BTLOG(@"Ignore stale disconnect callback (still connected): %@", address);
        return;
    }

    [self unregisterDisconnectNotificationForAddress:address];

    if (self.channel) {
        IOBluetoothDevice *channelDevice = [self.channel getDevice];
        NSString *channelAddress = normalizedAddress(channelDevice.addressString ?: @"");
        if (channelAddress.length == 0 || [channelAddress isEqualToString:addressKey]) {
            BTLOG(@"RFCOMM closed by disconnect callback (%@)", address);
            self.channel = nil;
        }
    }

    if (self.device) {
        NSString *deviceAddress = normalizedAddress(self.device.addressString ?: @"");
        if ([deviceAddress isEqualToString:addressKey]) {
            self.device = nil;
        }
    }

    macos_bt_on_device_event([address UTF8String], 0);
}

- (void)sdpQueryComplete:(IOBluetoothDevice *)device status:(IOReturn)status {
    NSString *address = device.addressString ?: @"";
    NSString *key = normalizedAddress(address);

    @synchronized(self) {
        if (!self.pendingSDPAddress || [self.pendingSDPAddress isEqualToString:key]) {
            self.pendingSDPDone = YES;
            self.pendingSDPStatus = status;
        }
    }

    BTLOG(@"SDP query complete: status=%d (%@)", (int)status, address);
}

- (void)rfcommChannelData:(IOBluetoothRFCOMMChannel *)rfcommChannel
                     data:(void *)dataPointer
                   length:(size_t)dataLength {
    (void)rfcommChannel;
    if (dataPointer && dataLength > 0) {
        macos_bt_on_data((const uint8_t *)dataPointer, dataLength);
    }
}

- (void)rfcommChannelClosed:(IOBluetoothRFCOMMChannel *)rfcommChannel {
    if (self.channel == rfcommChannel) {
        self.channel = nil;
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

    NSString *target = normalizedAddress(address);
    NSArray *paired = [IOBluetoothDevice pairedDevices] ?: @[];
    for (IOBluetoothDevice *candidate in paired) {
        NSString *candidateAddress = normalizedAddress(candidate.addressString ?: @"");
        if (candidateAddress.length > 0 && [candidateAddress isEqualToString:target]) {
            return candidate;
        }
    }

    return nil;
}

char *macos_bt_list_paired_devices(void) {
    __block char *result = NULL;

    runOnMainSync(^{
        StoneBluetoothManager *manager = [StoneBluetoothManager shared];
        [manager ensureConnectionNotifications];

        NSMutableArray *entries = [NSMutableArray array];
        NSArray *paired = [IOBluetoothDevice pairedDevices] ?: @[];
        IOBluetoothSDPUUID *gaiaUUID = stoneGaiaSDPUUID();

        for (IOBluetoothDevice *device in paired) {
            NSString *address = device.addressString ?: @"";
            if (address.length == 0) {
                continue;
            }

            NSString *name = device.name ?: @"(unknown)";
            IOBluetoothSDPServiceRecord *gaiaRecord = [device getServiceRecordForUUID:gaiaUUID];

            [entries addObject:@{
                @"name" : name,
                @"address" : address,
                @"connected" : jsonBool([device isConnected]),
                @"has_gaia" : jsonBool(gaiaRecord != nil),
                @"paired" : jsonBool(YES)
            }];
        }

        result = jsonCStringFromObject(entries, "[]");
    });

    if (!result) {
        return strdup("[]");
    }
    return result;
}

char *macos_bt_scan_unpaired_stone_devices(void) {
    __block StoneDeviceInquiryCollector *collector = nil;
    dispatch_semaphore_t started = dispatch_semaphore_create(0);
    dispatch_semaphore_t done = dispatch_semaphore_create(0);

    dispatch_async(dispatch_get_main_queue(), ^{
        StoneBluetoothManager *manager = [StoneBluetoothManager shared];

        if (manager.scanInquiry) {
            (void)[manager.scanInquiry stop];
            manager.scanInquiry = nil;
            manager.scanCollector = nil;
        }

        collector = [[StoneDeviceInquiryCollector alloc] init];
        collector.doneSemaphore = done;

        IOBluetoothDeviceInquiry *inquiry = [IOBluetoothDeviceInquiry inquiryWithDelegate:collector];
        if (!inquiry) {
            dispatch_semaphore_signal(started);
            dispatch_semaphore_signal(done);
            return;
        }

        inquiry.updateNewDeviceNames = YES;
        inquiry.inquiryLength = 4;

        manager.scanCollector = collector;
        manager.scanInquiry = inquiry;

        IOReturn startStatus = [inquiry start];
        dispatch_semaphore_signal(started);

        if (startStatus != kIOReturnSuccess) {
            BTLOG(@"Inquiry start failed: status=%d", (int)startStatus);
            manager.scanInquiry = nil;
            manager.scanCollector = nil;
            dispatch_semaphore_signal(done);
            return;
        }

        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(),
                       ^{
                           StoneBluetoothManager *current = [StoneBluetoothManager shared];
                           if (current.scanCollector == collector && !collector.completed) {
                               (void)[current.scanInquiry stop];
                           }
                       });
    });

    dispatch_time_t startedWait = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(started, startedWait) != 0) {
        return strdup("[]");
    }

    dispatch_time_t doneWait = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(6 * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(done, doneWait) != 0) {
        dispatch_async(dispatch_get_main_queue(), ^{
            StoneBluetoothManager *manager = [StoneBluetoothManager shared];
            if (manager.scanCollector == collector) {
                (void)[manager.scanInquiry stop];
                manager.scanInquiry = nil;
                manager.scanCollector = nil;
            }
        });
        return strdup("[]");
    }

    __block NSArray *entries = @[];
    runOnMainSync(^{
        StoneBluetoothManager *manager = [StoneBluetoothManager shared];
        if (manager.scanCollector == collector) {
            entries = [collector.entriesByAddress allValues] ?: @[];
            manager.scanInquiry = nil;
            manager.scanCollector = nil;
        }
    });

    BTLOG(@"Inquiry result: %lu unpaired STONE", (unsigned long)entries.count);
    return jsonCStringFromObject(entries, "[]");
}

int macos_bt_sdp_query(const char *address) {
    if (!address) {
        return (int)kIOReturnBadArgument;
    }

    NSString *addr = [NSString stringWithUTF8String:address];
    if (!addr || addr.length == 0) {
        return (int)kIOReturnBadArgument;
    }

    @try {
        IOBluetoothDevice *device = findDeviceForAddress(addr);
        if (!device) {
            [StoneBluetoothManager shared].lastErrorContext = @"device_not_found";
            return (int)kIOReturnNotFound;
        }

        StoneBluetoothManager *manager = [StoneBluetoothManager shared];
        manager.device = device;
        [manager registerDisconnectNotification:device];
        return (int)[manager performSDPQueryAndWait:device timeout:kStoneOpTimeout];
    } @catch (NSException *exception) {
        [StoneBluetoothManager shared].lastErrorContext =
            [NSString stringWithFormat:@"exception:%@", exception.name];
        return (int)kIOReturnError;
    }
}

char *macos_bt_get_connection_info(void) {
    __block NSDictionary *info = nil;

    runOnMainSync(^{
        info = [[StoneBluetoothManager shared] currentConnectionInfo];
    });

    if (!info) {
        return strdup("{\"address\":\"\",\"link\":false,\"rfcomm\":false}");
    }

    return jsonCStringFromObject(info, "{\"address\":\"\",\"link\":false,\"rfcomm\":false}");
}

int macos_bt_connect(const char *address) {
    if (!address) {
        return (int)kIOReturnBadArgument;
    }

    NSString *addr = [NSString stringWithUTF8String:address];
    if (!addr || addr.length == 0) {
        return (int)kIOReturnBadArgument;
    }

    @try {
        IOReturn status = [[StoneBluetoothManager shared] connectToAddress:addr];
        return (int)status;
    } @catch (NSException *exception) {
        [StoneBluetoothManager shared].lastErrorContext =
            [NSString stringWithFormat:@"exception:%@", exception.name];
        return (int)kIOReturnError;
    }
}

int macos_bt_disconnect(void) {
    @try {
        IOReturn status = [[StoneBluetoothManager shared] disconnect];
        return (int)status;
    } @catch (NSException *exception) {
        [StoneBluetoothManager shared].lastErrorContext =
            [NSString stringWithFormat:@"exception:%@", exception.name];
        return (int)kIOReturnError;
    }
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
            [StoneBluetoothManager shared].lastErrorContext =
                [NSString stringWithFormat:@"exception:%@", exception.name];
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
