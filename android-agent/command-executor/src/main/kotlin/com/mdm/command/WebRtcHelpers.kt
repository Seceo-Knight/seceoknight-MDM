package com.mdm.command

import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import timber.log.Timber

/** SdpObserver with no-op defaults so callers override only what they need. */
open class SimpleSdp : SdpObserver {
    override fun onCreateSuccess(sdp: SessionDescription) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(error: String?) { Timber.w("screen: sdp create failed: $error") }
    override fun onSetFailure(error: String?) { Timber.w("screen: sdp set failed: $error") }
}

/** PeerConnection.Observer with no-op defaults (override onIceCandidate etc. as needed). */
open class MinimalPcObserver : PeerConnection.Observer {
    override fun onSignalingChange(newState: PeerConnection.SignalingState?) {}
    override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState?) {
        Timber.v("screen: ice state $newState")
    }
    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
    override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState?) {}
    override fun onIceCandidate(candidate: IceCandidate) {}
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
    override fun onAddStream(stream: MediaStream?) {}
    override fun onRemoveStream(stream: MediaStream?) {}
    override fun onDataChannel(dataChannel: DataChannel?) {}
    override fun onRenegotiationNeeded() {}
    override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}
}
