// ImageCaptureCore owner for PTP pass-through. Every ICC object is touched on the main queue;
// callers on other threads block on a semaphore until the main-queue work completes.

#import <Foundation/Foundation.h>
#import <ImageCaptureCore/ImageCaptureCore.h>
#import <objc/message.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum {
    PC_ICC_OK = 0,
    PC_ICC_REMOVED = 1,
    PC_ICC_IN_USE = 2,
    PC_ICC_PERMISSION = 3,
    PC_ICC_TIMED_OUT = 4,
    PC_ICC_NOT_FOUND = 5,
    PC_ICC_NO_PTP = 6,
    PC_ICC_NATIVE = 7,
    PC_ICC_NOT_STARTED = 8,
    PC_ICC_MAIN_THREAD = 9,
};

enum {
    PC_ICC_EVENT_PTP = 0,
    PC_ICC_EVENT_REMOVED = 1,
    PC_ICC_EVENT_SESSION_CLOSED = 2,
    PC_ICC_EVENT_DEVICES = 3,
};

typedef struct {
    int64_t code;
    char domain[128];
    char message[512];
} photocull_icc_error;

typedef void (*photocull_icc_callback)(void *context, uint64_t generation, uint32_t kind,
                                       const uint8_t *data, size_t length);
// Receives ownership of `handle`, a retained NSData viewed by `data`/`length`.
typedef void (*photocull_icc_late_callback)(void *context, uint64_t generation, uint16_t opcode,
                                            uint32_t param1, void *handle, const uint8_t *data,
                                            size_t length);

enum {
    PC_PTP_GET_OBJECT = 0x1009,
    PC_PTP_RESPONSE_BLOCK = 3,
    PC_PTP_OK = 0x2001,
};

static void set_error(photocull_icc_error *out, NSError *error, NSString *fallback) {
    if (!out) return;
    memset(out, 0, sizeof(*out));
    NSString *domain = error ? error.domain : @"PhotoCull";
    NSString *message = error ? error.localizedDescription : fallback;
    out->code = error ? (int64_t)error.code : 0;
    if (domain) strlcpy(out->domain, domain.UTF8String ?: "", sizeof(out->domain));
    if (message) strlcpy(out->message, message.UTF8String ?: "", sizeof(out->message));
}

static BOOL wait_for(dispatch_semaphore_t done, double seconds) {
    dispatch_time_t deadline = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC));
    return dispatch_semaphore_wait(done, deadline) == 0;
}

// `finished` and `abandoned` change only on the main queue, so a timeout and a late completion
// cannot both claim the same call.
@interface PCCall : NSObject
@property(atomic) BOOL abandoned;
@property(atomic) BOOL finished;
@property(atomic, strong) NSData *payload;
@property(atomic, strong) NSData *response;
@property(atomic, strong) NSError *error;
@property(atomic) int32_t status;
@end

@implementation PCCall
@end

@interface PCBridge : NSObject <ICDeviceBrowserDelegate, ICCameraDeviceDelegate>
@property(nonatomic, strong) ICDeviceBrowser *browser;
@property(nonatomic, strong) NSMutableArray<ICCameraDevice *> *cameras;
@property(nonatomic, strong) ICCameraDevice *active;
@property(nonatomic) uint64_t generation;
@property(nonatomic) BOOL sessionOpen;
@property(nonatomic) BOOL usesEventHandler;
@property(atomic) NSInteger quarantined;
@property(nonatomic) photocull_icc_callback callback;
@property(nonatomic) photocull_icc_late_callback lateCallback;
@property(nonatomic) void *context;
@end

static PCBridge *g_bridge;

@implementation PCBridge

- (void)emit:(uint64_t)generation kind:(uint32_t)kind data:(NSData *)data {
    if (!self.callback) return;
    self.callback(self.context, generation, kind, data ? data.bytes : NULL, data ? data.length : 0);
}

- (void)deviceBrowser:(ICDeviceBrowser *)browser didAddDevice:(ICDevice *)device moreComing:(BOOL)moreComing {
    if (![device isKindOfClass:[ICCameraDevice class]]) return;
    if (![self.cameras containsObject:(ICCameraDevice *)device]) [self.cameras addObject:(ICCameraDevice *)device];
    if (!moreComing) [self emit:0 kind:PC_ICC_EVENT_DEVICES data:nil];
}

- (void)deviceBrowser:(ICDeviceBrowser *)browser didRemoveDevice:(ICDevice *)device moreGoing:(BOOL)moreGoing {
    [self forget:device];
    if (!moreGoing) [self emit:0 kind:PC_ICC_EVENT_DEVICES data:nil];
}

- (void)forget:(ICDevice *)device {
    if ([device isKindOfClass:[ICCameraDevice class]]) [self.cameras removeObject:(ICCameraDevice *)device];
    if (device == self.active) {
        uint64_t generation = self.generation;
        self.active.delegate = nil;
        self.active = nil;
        self.sessionOpen = NO;
        self.quarantined = 0;
        [self emit:generation kind:PC_ICC_EVENT_REMOVED data:nil];
    }
}

- (void)didRemoveDevice:(ICDevice *)device {
    [self forget:device];
}

- (void)device:(ICDevice *)device didOpenSessionWithError:(NSError *)error {
}

- (void)device:(ICDevice *)device didCloseSessionWithError:(NSError *)error {
    if (device == self.active && self.sessionOpen) {
        self.sessionOpen = NO;
        [self emit:self.generation kind:PC_ICC_EVENT_SESSION_CLOSED data:nil];
    }
}

- (void)deviceDidBecomeReady:(ICDevice *)device {
}

- (void)device:(ICDevice *)device didEncounterError:(NSError *)error {
}

- (void)device:(ICDevice *)device didReceiveStatusInformation:(NSDictionary *)status {
}

- (void)cameraDevice:(ICCameraDevice *)camera didAddItems:(NSArray<ICCameraItem *> *)items {
}

- (void)cameraDevice:(ICCameraDevice *)camera didRemoveItems:(NSArray<ICCameraItem *> *)items {
}

- (void)cameraDevice:(ICCameraDevice *)camera didRenameItems:(NSArray<ICCameraItem *> *)items {
}

- (void)cameraDevice:(ICCameraDevice *)camera
    didReceiveThumbnail:(CGImageRef)thumbnail
                forItem:(ICCameraItem *)item
                  error:(NSError *)error {
}

- (void)cameraDevice:(ICCameraDevice *)camera
    didReceiveMetadata:(NSDictionary *)metadata
               forItem:(ICCameraItem *)item
                 error:(NSError *)error {
}

- (void)cameraDeviceDidChangeCapability:(ICCameraDevice *)camera {
}

- (void)deviceDidBecomeReadyWithCompleteContentCatalog:(ICCameraDevice *)camera {
}

- (void)cameraDeviceDidRemoveAccessRestriction:(ICDevice *)device {
}

- (void)cameraDeviceDidEnableAccessRestriction:(ICDevice *)device {
}

- (void)cameraDevice:(ICCameraDevice *)camera didReceivePTPEvent:(NSData *)eventData {
    if (camera != self.active || self.usesEventHandler) return;
    [self emit:self.generation kind:PC_ICC_EVENT_PTP data:eventData];
}

@end

static void on_main(dispatch_block_t block) {
    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }
}

static void on_main_async(dispatch_block_t block) {
    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_async(dispatch_get_main_queue(), block);
    }
}

// Closes a native session nobody owns: a body without PTP, or one that opened after its caller
// gave up.
static void release_orphan_session(ICCameraDevice *camera) {
    if (g_bridge.active == camera) {
        if ([camera respondsToSelector:NSSelectorFromString(@"setPtpEventHandler:")]) {
            ((void (*)(id, SEL, id))objc_msgSend)(camera, NSSelectorFromString(@"setPtpEventHandler:"), nil);
        }
        camera.delegate = nil;
        g_bridge.active = nil;
        g_bridge.sessionOpen = NO;
        g_bridge.quarantined = 0;
        g_bridge.generation = 0;
    }
    [camera requestCloseSessionWithOptions:@{} completion:^(NSError *closeError) {
    }];
}

// Waits for a call; on timeout either marks it abandoned or, if its completion already ran on
// the main queue, takes the finished result.
static BOOL wait_or_abandon(PCCall *call, dispatch_semaphore_t done, double seconds,
                            dispatch_block_t onAbandon) {
    if (wait_for(done, seconds)) return YES;
    __block BOOL finished = NO;
    on_main(^{
        if (call.finished) {
            finished = YES;
            return;
        }
        call.abandoned = YES;
        if (onAbandon) onAbandon();
    });
    if (finished) dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    return finished;
}

static uint16_t container_code(NSData *container) {
    if (container.length < 8) return 0;
    const uint8_t *bytes = container.bytes;
    return (uint16_t)(bytes[6] | (bytes[7] << 8));
}

static const uint32_t PC_SONY_CAPTURE_HANDLE = 0xFFFFC001u;

static uint32_t container_param1(NSData *container) {
    if (container.length < 16) return 0;
    const uint8_t *b = container.bytes;
    return (uint32_t)b[12] | ((uint32_t)b[13] << 8) | ((uint32_t)b[14] << 16) | ((uint32_t)b[15] << 24);
}

static BOOL is_ok_response(NSData *response) {
    if (response.length < 12) return NO;
    const uint8_t *b = response.bytes;
    return (b[4] | (b[5] << 8)) == PC_PTP_RESPONSE_BLOCK && container_code(response) == PC_PTP_OK;
}

// A GetObject of the captured photo that finished after its caller timed out carries a photo the
// camera has already handed over; it goes to Rust instead of being dropped. Live View frames and
// any other late data are dropped. Runs on the main queue.
static void deliver_late_object(uint64_t generation, NSData *command, NSData *inData, NSData *response,
                                NSError *sendError) {
    PCBridge *bridge = g_bridge;
    if (!bridge || !bridge.lateCallback || sendError || inData.length == 0) return;
    uint16_t opcode = container_code(command);
    uint32_t param1 = container_param1(command);
    if (opcode != PC_PTP_GET_OBJECT || param1 != PC_SONY_CAPTURE_HANDLE || !is_ok_response(response)) return;
    bridge.lateCallback(bridge.context, generation, opcode, param1, (__bridge_retained void *)inData,
                        inData.bytes, inData.length);
}

static ICCameraDevice *find_camera(NSString *identifier) {
    for (ICCameraDevice *camera in g_bridge.cameras) {
        if ([camera.UUIDString isEqualToString:identifier]) return camera;
    }
    return nil;
}

int32_t photocull_icc_start(photocull_icc_callback callback, photocull_icc_late_callback late,
                            void *context) {
    __block int32_t status = PC_ICC_OK;
    on_main(^{
        if (g_bridge) {
            g_bridge.callback = callback;
            g_bridge.lateCallback = late;
            g_bridge.context = context;
            return;
        }
        PCBridge *bridge = [PCBridge new];
        bridge.cameras = [NSMutableArray array];
        bridge.callback = callback;
        bridge.lateCallback = late;
        bridge.context = context;
        ICDeviceBrowser *browser = [ICDeviceBrowser new];
        browser.delegate = bridge;
        browser.browsedDeviceTypeMask =
            (ICDeviceTypeMask)(ICDeviceTypeMaskCamera | ICDeviceLocationTypeMaskLocal);
        bridge.browser = browser;
        g_bridge = bridge;
        SEL request = NSSelectorFromString(@"requestControlAuthorizationWithCompletion:");
        if ([browser respondsToSelector:request]) {
            void (^done)(NSString *) = ^(NSString *authorization) {
            };
            ((void (*)(id, SEL, id))objc_msgSend)(browser, request, done);
        }
        [browser start];
    });
    return status;
}

int32_t photocull_icc_list_devices(uint8_t **out, size_t *out_len) {
    if (!out || !out_len) return PC_ICC_NATIVE;
    *out = NULL;
    *out_len = 0;
    __block NSData *json = nil;
    __block int32_t status = PC_ICC_OK;
    on_main(^{
        if (!g_bridge) {
            status = PC_ICC_NOT_STARTED;
            return;
        }
        NSMutableArray *list = [NSMutableArray array];
        for (ICCameraDevice *camera in g_bridge.cameras) {
            BOOL ptp = [camera.capabilities containsObject:ICCameraDeviceCanAcceptPTPCommands];
            [list addObject:@{
                @"id" : camera.UUIDString ?: @"",
                @"name" : camera.name ?: @"",
                @"usbVendorId" : @(camera.usbVendorID),
                @"usbProductId" : @(camera.usbProductID),
                @"usbLocationId" : @(camera.usbLocationID),
                @"canSendPtp" : [NSNumber numberWithBool:ptp],
                @"active" : [NSNumber numberWithBool:camera == g_bridge.active],
                @"sessionOpen" : [NSNumber numberWithBool:camera == g_bridge.active && g_bridge.sessionOpen],
                @"transport" : camera.transportType ?: @"",
            }];
        }
        json = [NSJSONSerialization dataWithJSONObject:list options:0 error:nil];
    });
    if (status != PC_ICC_OK) return status;
    if (!json) return PC_ICC_NATIVE;
    uint8_t *bytes = malloc(json.length ? json.length : 1);
    if (!bytes) return PC_ICC_NATIVE;
    memcpy(bytes, json.bytes, json.length);
    *out = bytes;
    *out_len = json.length;
    return PC_ICC_OK;
}

int32_t photocull_icc_open_session(const char *device_id, uint64_t generation, double timeout,
                                   photocull_icc_error *error) {
    if ([NSThread isMainThread]) return PC_ICC_MAIN_THREAD;
    if (!device_id) return PC_ICC_NOT_FOUND;
    NSString *identifier = [NSString stringWithUTF8String:device_id];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    PCCall *call = [PCCall new];
    call.status = PC_ICC_OK;
    __block BOOL started = NO;
    on_main(^{
        if (!g_bridge) {
            call.status = PC_ICC_NOT_STARTED;
            return;
        }
        ICCameraDevice *camera = find_camera(identifier);
        if (!camera) {
            call.status = PC_ICC_NOT_FOUND;
            return;
        }
        if (g_bridge.active && g_bridge.active != camera && g_bridge.sessionOpen) {
            call.status = PC_ICC_IN_USE;
            return;
        }
        g_bridge.active = camera;
        g_bridge.generation = generation;
        g_bridge.sessionOpen = NO;
        g_bridge.quarantined = 0;
        g_bridge.usesEventHandler = NO;
        camera.delegate = g_bridge;
        SEL handler = NSSelectorFromString(@"setPtpEventHandler:");
        if (@available(macOS 12.0, *)) {
            if ([camera respondsToSelector:handler]) {
                __weak PCBridge *weakBridge = g_bridge;
                __weak ICCameraDevice *weakCamera = camera;
                void (^onEvent)(NSData *) = ^(NSData *eventData) {
                    PCBridge *bridge = weakBridge;
                    if (!bridge || bridge.active != weakCamera || bridge.generation != generation) return;
                    [bridge emit:generation kind:PC_ICC_EVENT_PTP data:eventData];
                };
                ((void (*)(id, SEL, id))objc_msgSend)(camera, handler, onEvent);
                g_bridge.usesEventHandler = YES;
            }
        }
        started = YES;
        [camera requestOpenSessionWithOptions:@{}
                                   completion:^(NSError *openError) {
            on_main_async(^{
                BOOL current = g_bridge && g_bridge.active == camera && g_bridge.generation == generation;
                if (call.abandoned) {
                    // Opened after the caller timed out: nobody owns this session. A newer
                    // attempt on the same body keeps it.
                    if (!openError && g_bridge && (current || g_bridge.active != camera))
                        release_orphan_session(camera);
                    return;
                }
                if (!current) {
                    if (!openError && g_bridge && g_bridge.active != camera) release_orphan_session(camera);
                    call.status = PC_ICC_REMOVED;
                } else if (openError) {
                    call.error = openError;
                    call.status = PC_ICC_NATIVE;
                } else if (![camera.capabilities containsObject:ICCameraDeviceCanAcceptPTPCommands]) {
                    release_orphan_session(camera);
                    call.status = PC_ICC_NO_PTP;
                } else {
                    g_bridge.sessionOpen = YES;
                }
                call.finished = YES;
                dispatch_semaphore_signal(done);
            });
        }];
    });
    if (!started) {
        set_error(error, nil, @"The camera is not available.");
        return call.status;
    }
    if (!wait_or_abandon(call, done, timeout, nil)) {
        set_error(error, nil, @"The camera did not open its session in time.");
        return PC_ICC_TIMED_OUT;
    }
    if (call.status != PC_ICC_OK) set_error(error, call.error, @"The camera session could not be opened.");
    return call.status;
}

// On success `payload_handle` owns the inbound NSData (release with photocull_icc_release_data);
// `payload`/`payload_len` view its bytes. The response container is copied into `response`.
int32_t photocull_icc_send_ptp(uint64_t generation, const uint8_t *command, size_t command_len,
                               const uint8_t *out_data, size_t out_len, double timeout,
                               void **payload_handle, const uint8_t **payload, size_t *payload_len,
                               uint8_t *response, size_t response_cap, size_t *response_len,
                               photocull_icc_error *error) {
    if ([NSThread isMainThread]) return PC_ICC_MAIN_THREAD;
    if (!command || command_len < 12 || command_len > 32 || !payload_handle || !payload || !payload_len ||
        !response || !response_len)
        return PC_ICC_NATIVE;
    *payload_handle = NULL;
    *payload = NULL;
    *payload_len = 0;
    *response_len = 0;
    NSData *commandData = [NSData dataWithBytes:command length:command_len];
    NSData *outData = out_data ? [NSData dataWithBytes:out_data length:out_len] : nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    PCCall *call = [PCCall new];
    call.status = PC_ICC_OK;
    __block BOOL started = NO;
    on_main(^{
        PCBridge *bridge = g_bridge;
        if (!bridge || !bridge.active || bridge.generation != generation) {
            call.status = PC_ICC_REMOVED;
            return;
        }
        if (!bridge.sessionOpen) {
            call.status = PC_ICC_REMOVED;
            return;
        }
        if (bridge.quarantined > 0) {
            call.status = PC_ICC_TIMED_OUT;
            return;
        }
        ICCameraDevice *camera = bridge.active;
        started = YES;
        [camera requestSendPTPCommand:commandData
                              outData:outData
                           completion:^(NSData *inData, NSData *responseData, NSError *sendError) {
            on_main_async(^{
                if (call.abandoned) {
                    // The timeout quarantined this generation; the late answer lifts it.
                    if (g_bridge && g_bridge.generation == generation && g_bridge.quarantined > 0)
                        g_bridge.quarantined -= 1;
                    deliver_late_object(generation, commandData, inData, responseData, sendError);
                    return;
                }
                call.payload = inData;
                call.response = responseData;
                call.error = sendError;
                if (sendError) call.status = PC_ICC_NATIVE;
                call.finished = YES;
                dispatch_semaphore_signal(done);
            });
        }];
    });
    if (!started) {
        set_error(error, nil, @"The camera is not connected.");
        return call.status;
    }
    if (!wait_or_abandon(call, done, timeout, ^{
            if (g_bridge && g_bridge.generation == generation) g_bridge.quarantined += 1;
        })) {
        set_error(error, nil, @"The camera did not answer in time.");
        return PC_ICC_TIMED_OUT;
    }
    if (call.status != PC_ICC_OK) {
        set_error(error, call.error, @"The camera command failed.");
        return call.status;
    }
    NSData *responseData = call.response;
    if (responseData) {
        size_t n = responseData.length < response_cap ? responseData.length : response_cap;
        memcpy(response, responseData.bytes, n);
        *response_len = responseData.length;
    }
    NSData *inData = call.payload;
    if (inData && inData.length > 0) {
        *payload_handle = (__bridge_retained void *)inData;
        *payload = inData.bytes;
        *payload_len = inData.length;
    }
    return PC_ICC_OK;
}

void photocull_icc_release_data(void *handle) {
    if (handle) CFRelease(handle);
}

int32_t photocull_icc_close_session(uint64_t generation, double timeout, photocull_icc_error *error) {
    if ([NSThread isMainThread]) return PC_ICC_MAIN_THREAD;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    PCCall *call = [PCCall new];
    call.status = PC_ICC_OK;
    __block BOOL started = NO;
    on_main(^{
        PCBridge *bridge = g_bridge;
        if (!bridge || !bridge.active || bridge.generation != generation) return;
        ICCameraDevice *camera = bridge.active;
        BOOL open = bridge.sessionOpen;
        bridge.sessionOpen = NO;
        bridge.quarantined = 0;
        bridge.generation = 0;
        bridge.active = nil;
        if ([camera respondsToSelector:NSSelectorFromString(@"setPtpEventHandler:")]) {
            ((void (*)(id, SEL, id))objc_msgSend)(camera, NSSelectorFromString(@"setPtpEventHandler:"), nil);
        }
        camera.delegate = nil;
        if (!open) return;
        started = YES;
        [camera requestCloseSessionWithOptions:@{}
                                    completion:^(NSError *closeError) {
                                        call.error = closeError;
                                        if (closeError) call.status = PC_ICC_NATIVE;
                                        dispatch_semaphore_signal(done);
                                    }];
    });
    if (!started) return PC_ICC_OK;
    if (!wait_for(done, timeout)) {
        call.abandoned = YES;
        set_error(error, nil, @"The camera did not close its session in time.");
        return PC_ICC_TIMED_OUT;
    }
    if (call.status != PC_ICC_OK) set_error(error, call.error, @"The camera session did not close cleanly.");
    return call.status;
}

void photocull_icc_stop(void) {
    on_main(^{
        PCBridge *bridge = g_bridge;
        if (!bridge) return;
        bridge.callback = NULL;
        bridge.lateCallback = NULL;
        bridge.context = NULL;
        if (bridge.active) {
            bridge.active.delegate = nil;
            if (bridge.sessionOpen) [bridge.active requestCloseSessionWithOptions:@{} completion:^(NSError *e) {}];
        }
        bridge.active = nil;
        bridge.sessionOpen = NO;
        [bridge.browser stop];
        bridge.browser.delegate = nil;
        g_bridge = nil;
    });
}

// Runs the main run loop briefly so main-queue ICC work can finish while the main thread waits.
void photocull_icc_pump(double seconds) {
    if ([NSThread isMainThread]) CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, true);
}

void photocull_icc_free_bytes(uint8_t *bytes, size_t length) {
    (void)length;
    free(bytes);
}
