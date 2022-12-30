import { GoogleLogin } from "@react-oauth/google";
import { ethers, utils } from "ethers";
import LitJsSdk from "lit-js-sdk";
import { useState } from "react";
import "./App.css";

window.LitJsSdk = LitJsSdk;
window.ethers = ethers;

// const RELAY_API_URL = process.env.RELAY_API_URL || 'https://lit-relay-server.api.3wlabs.xyz:3001';
const RELAY_API_URL = process.env.RELAY_API_URL || 'https://localhost:3001';

function App() {
  const [pkpEthAddress, setPkpEthAddress] = useState(null);
  const [googleCredentialResponse, setGoogleCredentialResponse] =
    useState(null);
  const [pkpPublicKey, setPkpPublicKey] = useState(null);
  const [status, setStatus] = useState("");

  const handleLoggedInToGoogle = async (credentialResponse) => {
    setStatus("Logged in to Google");
    console.log("Got response from google sign in: ", { credentialResponse });
    setGoogleCredentialResponse(credentialResponse);
    const requestId = await mintPkpWithRelayer(credentialResponse);
    await pollRequestUntilTerminalState(requestId);
  };

  const mintPkpWithRelayer = async (credentialResponse) => {
    setStatus("Minting PKP with relayer...");

    const mintRes = await fetch(`${RELAY_API_URL}/auth/google`, {
      method: "POST",
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idToken: credentialResponse.credential
      }),
    });

    if (mintRes.status < 200 || mintRes.status >= 400) {
      console.warn("Something wrong with the API call", await mintRes.json());
      setStatus("Uh oh, something's not quite right.");
      return null;
    } else {
      const resBody = await mintRes.json();
      console.log("Response OK", { body: resBody });
      setStatus("Successfully initiated minting PKP with relayer.")
      return resBody.requestId;
    }
  }

  const pollRequestUntilTerminalState = async (requestId) => {
    if (!requestId) {
      return;
    }

    const maxPollCount = 20;
    for (let i = 0; i < maxPollCount; i++) {
      setStatus(`Waiting for auth completion (poll #${i+1})`);
      const getAuthStatusRes = await fetch(`${RELAY_API_URL}/auth/status/${requestId}`);

      if (getAuthStatusRes.status < 200 || getAuthStatusRes.status >= 400) {
        console.warn("Something wrong with the API call", await getAuthStatusRes.json());
        setStatus("Uh oh, something's not quite right.");
        return;
      }

      const resBody = await getAuthStatusRes.json();
      console.log("Response OK", { body: resBody });

      if (resBody.error) {
        // exit loop since error
        console.warn("Something wrong with the API call", { error: resBody.error });
        setStatus("Uh oh, something's not quite right.");
        return;
      } else if (resBody.status === "Succeeded") {
        // exit loop since success
        console.info("Successfully authed", { ...resBody });
        setStatus("Successfully authed and minted PKP!");
        setPkpEthAddress(resBody.pkpEthAddress);
        setPkpPublicKey(resBody.pkpPublicKey);
        return;
      }

      // otherwise, sleep then continue polling
      await new Promise(r => setTimeout(r, 15000));
    }

    // at this point, polling ended and still no success, set failure status
    setStatus(`Hmm this is taking longer than expected...`)
  } 

  const handleSendTransactionViaLitAction = async () => {
    const provider = new ethers.providers.JsonRpcProvider(
      "https://polygon-mumbai.g.alchemy.com/v2/onvoLvV97DDoLkAmdi0Cj7sxvfglKqDh"
    );

    const testName = "sendPKPTransaction";
    console.debug(`Testing ${testName}...`);

    // Change the litNetwork to "serrano" in the Client initiation in utils/init.js
    const transactionParams = {
      provider, 
      to: "0x0b1C5E9E82393AD5d1d1e9a498BF7bAAC13b31Ee",
      value: "0x000001",
      data: "0x",
      gasPrice: "0x2e90edd000",
      gasLimit: "0x" + (30000).toString(16),
      chain: "mumbai",
      publicKey:  
        // the publicKey is a LIT Staff members's PKP -> replace with your own.
        pkpPublicKey,
    };

    const litNodeClient = new LitJsSdk.LitNodeClient({
      litNetwork: "serrano",
    });
    await litNodeClient.connect();

    const transactionRequest = await litNodeClient.sendPKPTransaction(
      transactionParams
    );

    console.log("Lit Action Transaction result:", transactionRequest);

    document.getElementById(
      "status"
    ).innerText = `${testName}: Success.  result is: ${transactionRequest}`;
  }

  const handleTest = async () => {
    handleSendTransactionViaLitAction();
    // const authSig = await LitJsSdk.checkAndSignAuthMessage({ chain: "mumbai" });
    // console.debug("authSig", authSig);
  };

  const handleStoreEncryptionCondition = async () => {
    setStatus("Storing encryption condition...");
    var unifiedAccessControlConditions = [
      {
        conditionType: "evmBasic",
        contractAddress: "",
        standardContractType: "",
        chain: "mumbai",
        method: "",
        parameters: [":userAddress"],
        returnValueTest: {
          comparator: "=",
          value: pkpEthAddress,
        },
      },
    ];

    // this will be fired if auth is needed. we can use this to prompt the user to sign in
    const authNeededCallback = async ({
      chain,
      resources,
      expiration,
      uri,
      litNodeClient,
    }) => {
      console.log("authNeededCallback fired");
      const sessionSig = await litNodeClient.signSessionKey({
        sessionKey: uri,
        authMethods: [
          {
            authMethodType: 6,
            accessToken: googleCredentialResponse.credential,
          },
        ],
        pkpPublicKey,
        expiration,
        resources,
        chain,
      });
      console.log("got session sig from node and PKP: ", sessionSig);
      return sessionSig;
    };

    // get the user a session with it
    const litNodeClient = new LitJsSdk.LitNodeClient({
      litNetwork: "serrano",
    });
    await litNodeClient.connect();

    const sessionSigs = await litNodeClient.getSessionSigs({
      // expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(), // 24 hours
      expiration: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 2).toISOString(), // 2 years
      chain: "ethereum",
      resources: [`litEncryptionCondition://*`],
      sessionCapabilityObject: {
        def: ["litEncryptionCondition"]
      },
      switchChain: false,
      authNeededCallback,
    });
    console.log("sessionSigs before saving encryption key: ", sessionSigs);

    const { encryptedZip, symmetricKey } = await LitJsSdk.zipAndEncryptString(
      "this is a secret message"
    );

    // value parameter - hash unified conditions
    const hashedAccessControlConditions = await LitJsSdk.hashUnifiedAccessControlConditions(unifiedAccessControlConditions);
    console.log("hashedAccessControlConditions", { hashedAccessControlConditions });
    const hashedAccessControlConditionsStr = LitJsSdk.uint8arrayToString(new Uint8Array(hashedAccessControlConditions), "base16");

    // key parameter - encrypt symmetric key then hash it 
    const encryptedSymmetricKey = LitJsSdk.encryptWithBlsPubkey({
      pubkey: litNodeClient.networkPubKey,
      data: symmetricKey,
    });
    const hashedEncryptedSymmetricKeyStr = await LitJsSdk.hashEncryptionKey({ encryptedSymmetricKey });
    
    // securityHash parameter - encrypt symmetric key, concat with creator address
    const pkpEthAddressBytes = utils.arrayify(pkpEthAddress);
    const securityHashPreimage = new Uint8Array([...encryptedSymmetricKey, ...pkpEthAddressBytes]);
    // TODO: LitJsSdk.hashEncryptionKey ought to be renamed to just .hashBytes
    const securityHashStr = await LitJsSdk.hashEncryptionKey({ encryptedSymmetricKey: securityHashPreimage });

    console.log("Storing encryption condition with relay", {
      hashedEncryptedSymmetricKeyStr,
      hashedAccessControlConditionsStr,
      securityHashStr,
      sessionSig: sessionSigs["https://serrano.litgateway.com:7370"],
    });

    // call centralized conditions relayer to write encryption conditions to chain.
    const storeRes = await fetch(`${RELAY_API_URL}/store-condition`, {
      method: "POST",
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        key: hashedEncryptedSymmetricKeyStr,
        value: hashedAccessControlConditionsStr,
        securityHash: securityHashStr,
        chainId: "1",
        permanent: false,
        capabilityProtocolPrefix: "litEncryptionCondition",
        // just choose any one session signature that is generated.
        sessionSig: sessionSigs["https://serrano.litgateway.com:7370"],
      }),
    });

    if (storeRes.status < 200 || storeRes.status >= 400) {
      console.warn("Something wrong with the API call", await storeRes.json());
      setStatus("Uh oh, something's not quite right");
    } else {
      setStatus("Successfully stored encryption condition with relayer!");
    }
  }

  const handleEncryptThenDecrypt = async () => {
    setStatus("Encrypting then decrypting...");
    var unifiedAccessControlConditions = [
      {
        conditionType: "evmBasic",
        contractAddress: "",
        standardContractType: "",
        chain: "mumbai",
        method: "",
        parameters: [":userAddress"],
        returnValueTest: {
          comparator: "=",
          value: pkpEthAddress,
        },
      },
    ];

    // this will be fired if auth is needed. we can use this to prompt the user to sign in
    const authNeededCallback = async ({
      chain,
      resources,
      expiration,
      uri,
      litNodeClient,
    }) => {
      console.log("authNeededCallback fired");
      const sessionSig = await litNodeClient.signSessionKey({
        sessionKey: uri,
        authMethods: [
          {
            authMethodType: 6,
            accessToken: googleCredentialResponse.credential,
          },
        ],
        pkpPublicKey,
        expiration,
        resources,
        chain,
      });
      console.log("got session sig from node and PKP: ", sessionSig);
      return sessionSig;
    };

    // get the user a session with it
    const litNodeClient = new LitJsSdk.LitNodeClient({
      litNetwork: "serrano",
    });
    await litNodeClient.connect();

    const sessionSigs = await litNodeClient.getSessionSigs({
      expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(), // 24 hours
      chain: "ethereum",
      resources: [`litEncryptionCondition://*`],
      switchChain: false,
      authNeededCallback,
    });
    console.log("sessionSigs before saving encryption key: ", sessionSigs);

    const { encryptedZip, symmetricKey } = await LitJsSdk.zipAndEncryptString(
      "this is a secret message"
    );

    const encryptedSymmetricKey = await litNodeClient.saveEncryptionKey({
      unifiedAccessControlConditions,
      symmetricKey,
      sessionSigs,
    });

    const hashOfKey = await LitJsSdk.hashEncryptionKey({
      encryptedSymmetricKey,
    });

    console.log("encrypted symmetric key", encryptedSymmetricKey);

    const retrievedSymmKey = await litNodeClient.getEncryptionKey({
      unifiedAccessControlConditions,
      toDecrypt: LitJsSdk.uint8arrayToString(encryptedSymmetricKey, "base16"),
      sessionSigs,
    });

    const decryptedFiles = await LitJsSdk.decryptZip(
      encryptedZip,
      retrievedSymmKey
    );
    const decryptedString = await decryptedFiles["string.txt"].async("text");
    console.log("decrypted string", decryptedString);

    setStatus("Success!");
  };

  return (
    <div className="App">
      <div style={{ height: 50 }} />
      <h1>{status}</h1>
      <div style={{ height: 200 }} />
      <h3>
        Step 1: log in with Google. Upon OAuth success, we will mint a PKP on your behalf.
      </h3>
      <GoogleLogin
        onSuccess={handleLoggedInToGoogle}
        onError={() => {
          console.log("Login Failed");
        }}
        useOneTap
      />
      <div style={{ height: 100 }} />
      {pkpEthAddress && <div>PKP Eth Address: {pkpEthAddress}</div>}
      {pkpPublicKey && <div>PKP Public Key: {pkpPublicKey}</div>}
      <div style={{ height: 100 }} />
      <h3>Step 2: Use Lit Network to obtain a session sig before storing a condition.</h3>
      <button onClick={handleStoreEncryptionCondition}>
        Encrypt with Lit
      </button>

      <button onClick={handleTest}>
        Test
      </button>
    </div>
  );
}

export default App;
