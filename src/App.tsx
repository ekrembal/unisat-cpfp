import React, { useEffect, useRef, useState, useCallback } from "react";
import "./App.css";
import {
  Button,
  Card,
  CollapseProps,
  Input,
  Radio,
  InputNumber,
} from "antd";
import { Collapse } from "antd";
import useMessage from "antd/es/message/useMessage";
import { CHAINS_MAP, ChainType } from "./const";
import { copyToClipboard, satoshisToAmount } from "./utils";
import * as bitcoin from "bitcoinjs-lib";
import { Transaction } from "bitcoinjs-lib";
import * as ecc from "@bitcoin-js/tiny-secp256k1-asmjs";
import { SendBitcoinCard } from "./components/SendBitcoinCard";
import { PushPsbtCard } from "./components/PushPsbtCard";
import { PushTxCard } from "./components/PushTxCard";
import { SignMessageCard } from "./components/SignMessageCard";
import { SignPsbtCard } from "./components/SignPsbtCard";
import { InscribeTransferCard } from "./components/InscribeTransferCard";
import { SendInscriptionCard } from "./components/SendInscriptionCard";
import { SendRunesCard } from "./components/SendRunesCard";
import { MultiSignMessageCard } from "./components/MultiSignMessageCard";
import { SignPsbtsCard } from "./components/SignPsbtsCard";

// Initialize ECC library for web browsers
bitcoin.initEccLib(ecc);

// Helper function to serialize witness stack for PSBT finalScriptWitness
function serializeWitness(witnessStack: any[]): Buffer {
  // Write varint for the number of witness elements
  const varintBuf = (n: number): Buffer => {
    if (n < 0xfd) {
      const buf = Buffer.alloc(1);
      buf.writeUInt8(n, 0);
      return buf;
    } else if (n <= 0xffff) {
      const buf = Buffer.alloc(3);
      buf.writeUInt8(0xfd, 0);
      buf.writeUInt16LE(n, 1);
      return buf;
    } else if (n <= 0xffffffff) {
      const buf = Buffer.alloc(5);
      buf.writeUInt8(0xfe, 0);
      buf.writeUInt32LE(n, 1);
      return buf;
    } else {
      throw new Error('Value too large for varint');
    }
  };

  const parts: Buffer[] = [];
  parts.push(varintBuf(witnessStack.length));
  
  for (const item of witnessStack) {
    const itemBuf = Buffer.isBuffer(item) ? item : Buffer.from(item);
    parts.push(varintBuf(itemBuf.length));
    parts.push(itemBuf);
  }
  
  return Buffer.concat(parts as Uint8Array[]);
}

function App() {
  // Test to verify bitcoinjs-lib and ECC work
  useEffect(() => {
    try {
      // Test ECC initialization by trying address generation
      const testPublicKey = Buffer.from("03" + "00".repeat(32), "hex");
      const { address } = bitcoin.payments.p2pkh({ pubkey: testPublicKey });
      console.log("Bitcoin library with ECC test - address generation works:", address);
    } catch (error) {
      console.error("Bitcoin library ECC test failed:", error);
    }
  }, []);

  const [unisatInstalled, setUnisatInstalled] = useState(false);
  const [connected, setConnected] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [address, setAddress] = useState("");
  const [balanceV2, setBalanceV2] = useState({
    available: 0,
    unavailable: 0,
    total: 0,
  });
  const [network, setNetwork] = useState("livenet");

  const [version, setVersion] = useState("");

  const [chainType, setChainType] = useState<ChainType>(
    ChainType.BITCOIN_MAINNET
  );
  const [mempoolApiUrl, setMempoolApiUrl] = useState("https://mempool.space/");
  const [utxos, setUtxos] = useState<any[]>([]);
  const [utxoLoading, setUtxoLoading] = useState(false);
  const [rawTx, setRawTx] = useState("03000000000101e10131043e721928a369dd2574cc8ffb214461b480d7e30b767e33c094577bda0000000000fdffffff0218c69a3b00000000225120990211a64ee45bbf2e2bacff0c15f7ec7e0f8b838bcb715abb4a57aae4125cb5f0000000000000000451024e7301409eaedd13891795d0cf02b0440faf0c811ab2020406a5acec8a753eb058579f2d98bd403b9447becb25426af7b182a77433c2e3e4545b9496340646f68b1b0ff600000000");
  const [feeRate, setFeeRate] = useState(1);
  const [cpfpLoading, setCpfpLoading] = useState(false);
  const [decodedTx, setDecodedTx] = useState<Transaction | null>(null);
  const [txid, setTxid] = useState<string>("");
  const [txWeight, setTxWeight] = useState<number>(0);
  const [childTxStructure, setChildTxStructure] = useState<any>(null);
  const [utxoAutoReload, setUtxoAutoReload] = useState(false);

  // RBF state
  const [rbfRawTx, setRbfRawTx] = useState("");
  const [rbfFeeRate, setRbfFeeRate] = useState(10);
  const [rbfLoading, setRbfLoading] = useState(false);
  const [rbfDecodedTx, setRbfDecodedTx] = useState<Transaction | null>(null);
  const [rbfTxid, setRbfTxid] = useState<string>("");
  const [rbfTxWeight, setRbfTxWeight] = useState<number>(0);
  const [rbfTxStructure, setRbfTxStructure] = useState<any>(null);
  const [rbfSelectedUtxo, setRbfSelectedUtxo] = useState<string>("");

  const chain = CHAINS_MAP[chainType];
  const [messageApi, contextHolder] = useMessage();

  // Function to get the mempool API endpoint based on current chain
  const getMempoolApiEndpoint = useCallback(() => {
    let baseUrl = mempoolApiUrl.endsWith("/")
      ? mempoolApiUrl
      : mempoolApiUrl + "/";

    if (chainType === ChainType.BITCOIN_TESTNET4) {
      return baseUrl + "testnet4/api/";
    } else if (chainType === ChainType.BITCOIN_TESTNET) {
      return baseUrl + "testnet/api/";
    } else if (chainType === ChainType.BITCOIN_SIGNET) {
      return baseUrl + "signet/api/";
    } else {
      return baseUrl + "api/";
    }
  }, [mempoolApiUrl, chainType]);

  // Function to fetch UTXOs for the current address
  const fetchUtxos = useCallback(async (showSuccessMessage = true) => {
    if (!address) {
      if (showSuccessMessage) {
        messageApi.error("No address available");
      }
      return;
    }

    setUtxoLoading(true);
    try {
      const apiEndpoint = getMempoolApiEndpoint();
      const response = await fetch(`${apiEndpoint}address/${address}/utxo`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const utxoData = await response.json();
      setUtxos(utxoData);
      if (showSuccessMessage) {
        messageApi.success(`Loaded ${utxoData.length} UTXOs`);
      }
    } catch (error) {
      console.error("Error fetching UTXOs:", error);
      if (showSuccessMessage) {
        messageApi.error(`Failed to fetch UTXOs: ${error}`);
      } else {
        messageApi.warning("UTXO update failed");
      }
      setUtxos([]);
    } finally {
      setUtxoLoading(false);
    }
  }, [address, getMempoolApiEndpoint, messageApi]);

  // Function to create and sign CPFP child transaction
  const createAndSignChildTx = async () => {
    if (!rawTx.trim()) {
      messageApi.error("Please enter a raw transaction");
      return;
    }

    if (!address) {
      messageApi.error("No address available");
      return;
    }

    setCpfpLoading(true);
    try {
      // First, decode the transaction using bitcoinjs-lib
      console.log("Raw transaction:", rawTx.trim());
      console.log("Raw transaction length:", rawTx.trim().length);
      const transaction = Transaction.fromHex(rawTx.trim());
      const transactionId = transaction.getId();
      const transactionWeight = transaction.weight();
      
      setDecodedTx(transaction);
      setTxid(transactionId);
      setTxWeight(transactionWeight);

      console.log("Decoded transaction:", transaction);
      console.log("Transaction ID (getId()):", transactionId);
      console.log("Transaction weight:", transactionWeight);
      console.log("Expected weight: 496");

      // Calculate parent transaction fee
      let parentFee = 0;
      let parentFeeRate = 0;
      try {
        // Fetch parent transaction details to get input values
        const apiEndpoint = getMempoolApiEndpoint();
        const parentTxResponse = await fetch(`${apiEndpoint}tx/${transactionId}`);
        
        if (parentTxResponse.ok) {
          const parentTxData = await parentTxResponse.json();
          
          // Calculate total input value from the API data
          const totalInputValue = parentTxData.vin.reduce((sum: number, input: any) => {
            return sum + (input.prevout?.value || 0);
          }, 0);
          
          // Calculate total output value from our decoded transaction
          const totalOutputValue = transaction.outs.reduce((sum: number, output: any) => {
            return sum + output.value;
          }, 0);
          
          parentFee = totalInputValue - totalOutputValue;
          parentFeeRate = Math.ceil((parentFee / (transactionWeight / 4)) * 100) / 100; // Round to 2 decimal places
          
          console.log(`Parent transaction fee: ${parentFee} sats`);
          console.log(`Parent transaction fee rate: ${parentFeeRate} sat/vB`);
          console.log(`Parent inputs: ${totalInputValue} sats, outputs: ${totalOutputValue} sats`);
        } else {
          console.warn("Could not fetch parent transaction details for fee calculation");
        }
      } catch (feeError) {
        console.warn("Error calculating parent transaction fee:", feeError);
      }
      
      // Check for anchor output with script starting with "51024e73"
      const anchorOutput = transaction.outs.find(output => 
        output.script.toString("hex").startsWith("51024e73")
      );

      if (!anchorOutput) {
        messageApi.error("Error: There is no anchor output (script starting with 51024e73) in this transaction");
        return;
      }

      messageApi.success("Transaction decoded successfully! Anchor output found.");

      // Calculate package fee requirements (implementing Rust logic)
      const parentWeight = transactionWeight; // Already calculated above
      const estimatedChildWeight = 609; // Weight units for estimated child transaction
      const totalWeight = parentWeight + estimatedChildWeight;
      
      // Convert weight units to virtual bytes: vBytes = weight / 4
      // Then calculate fee: fee = vBytes * feeRate
      // Combined: fee = (weight / 4) * feeRate = weight * feeRate / 4
      // Use precise calculation to avoid floating point errors
      const totalVirtualBytes = Math.ceil(totalWeight / 4.0);
      const requiredFeeSats = Math.ceil(totalVirtualBytes * feeRate);
      
      console.log(`Parent weight: ${parentWeight} WU, estimated child: ${estimatedChildWeight} WU, total: ${totalWeight} WU`);
      console.log(`Total virtual bytes: ${totalVirtualBytes} vB, fee rate: ${feeRate} sat/vB, required fee: ${requiredFeeSats} sats`);

      // Find anchor output index and value
      const anchorOutputIndex = transaction.outs.findIndex(output => 
        output.script.toString("hex").startsWith("51024e73")
      );
      const anchorOutputValue = transaction.outs[anchorOutputIndex].value; // Should be 240 sats

      console.log(`Anchor output index: ${anchorOutputIndex}, value: ${anchorOutputValue} sats`);

      // UTXO selection from confirmed UTXOs
      const confirmedUtxos = utxos.filter(utxo => utxo.status.confirmed);
      
      if (confirmedUtxos.length === 0) {
        messageApi.error("No confirmed UTXOs available for fee payment. Please wait for confirmations or send more funds.");
        return;
      }

      // Find UTXO with enough balance for fee payment (minimum sufficient amount)
      const requiredUtxoValue = requiredFeeSats - anchorOutputValue; // Subtract anchor value from required fee
      
      // Filter UTXOs that have enough balance, then sort by value to get the smallest suitable one
      const suitableUtxos = confirmedUtxos
        .filter(utxo => utxo.value > requiredUtxoValue)
        .sort((a, b) => a.value - b.value); // Sort ascending to get minimum first

      if (suitableUtxos.length === 0) {
        messageApi.error(`No UTXO found with enough balance for fee payment. Required: ${requiredUtxoValue} sats, largest UTXO: ${Math.max(...confirmedUtxos.map(u => u.value))} sats`);
        return;
      }

      // Select the smallest UTXO that meets the requirement
      const suitableUtxo = suitableUtxos[0];
      console.log(`Selected minimum suitable UTXO: ${suitableUtxo.value} sats (required: ${requiredUtxoValue} sats, excess: ${suitableUtxo.value - requiredUtxoValue} sats)`);

      console.log(`Selected UTXO: ${suitableUtxo.txid}:${suitableUtxo.vout} with ${suitableUtxo.value} sats`);

      // Calculate change amount (ensure integer satoshi value)
      const totalInputValue = anchorOutputValue + suitableUtxo.value;
      const changeAmount = totalInputValue - requiredFeeSats;

      if (changeAmount < 0) {
        messageApi.error("Insufficient funds for required fee");
        return;
      }

      console.log(`Total input value: ${totalInputValue} sats, change amount: ${changeAmount} sats`);

      // Create child transaction structure with accurate fee calculations
      const childTxStructure = {
        version: 3,
        locktime: 0,
        inputs: [
          {
            // Anchor output from parent transaction
            txid: transactionId,
            vout: anchorOutputIndex,
            value: anchorOutputValue,
            scriptPubKey: transaction.outs[anchorOutputIndex].script.toString("hex")
          },
          {
            // Fee payer UTXO
            txid: suitableUtxo.txid,
            vout: suitableUtxo.vout,
            value: suitableUtxo.value,
            scriptPubKey: "" // Would need to be fetched from wallet
          }
        ],
        outputs: [
          {
            // Change output back to wallet
            value: changeAmount,
            scriptPubKey: "" // Would be the wallet's address script
          }
        ],
        // Accurate fee calculations
        parentWeight: parentWeight,
        parentFee: parentFee,
        parentFeeRate: parentFeeRate,
        estimatedChildWeight: estimatedChildWeight,
        totalWeight: totalWeight,
        totalVirtualBytes: totalVirtualBytes,
        feeRate: feeRate,
        totalFee: requiredFeeSats,
        // Package fee rate calculation
        packageFeeRate: Math.round(requiredFeeSats / totalVirtualBytes * 100) / 100 // Round to 2 decimal places
      };

      console.log("Child transaction structure:", childTxStructure);
      setChildTxStructure(childTxStructure);

      // Create PSBT for the child transaction
      try {
        // Determine the network based on chain type
        const btcNetwork = chainType === ChainType.BITCOIN_MAINNET ? 
          bitcoin.networks.bitcoin : bitcoin.networks.testnet;
        
        console.log("Creating PSBT with network:", btcNetwork === bitcoin.networks.bitcoin ? "mainnet" : "testnet");
        
        // Create PSBT for web browsers
        console.log("Creating PSBT for web environment");
        const psbt = new bitcoin.Psbt({ network: btcNetwork });
        console.log("PSBT created successfully");
        
        // Add anchor output as first input
        psbt.addInput({
          hash: transactionId,
          index: anchorOutputIndex,
          witnessUtxo: {
            script: transaction.outs[anchorOutputIndex].script,
            value: anchorOutputValue
          }
        });

        // Add fee payer UTXO as second input
        // We'll fetch the actual scriptPubKey from the mempool API for this UTXO
        let feePayerScript: Buffer;
        
        try {
          // Fetch the transaction containing this UTXO to get the correct scriptPubKey
          const apiEndpoint = getMempoolApiEndpoint();
          const utxoTxResponse = await fetch(`${apiEndpoint}tx/${suitableUtxo.txid}`);
          
          if (!utxoTxResponse.ok) {
            throw new Error(`Failed to fetch UTXO transaction: ${utxoTxResponse.status}`);
          }
          
          const utxoTx = await utxoTxResponse.json();
          const utxoOutput = utxoTx.vout[suitableUtxo.vout];
          
          if (!utxoOutput || !utxoOutput.scriptpubkey) {
            throw new Error("Could not find scriptPubKey for UTXO");
          }
          
          feePayerScript = Buffer.from(utxoOutput.scriptpubkey, 'hex');
          console.log("Fee payer script from API:", utxoOutput.scriptpubkey);
          
        } catch (apiError) {
          console.error("Error fetching UTXO script from API:", apiError);
          messageApi.error("Failed to fetch UTXO script. Please try again.");
          return;
        }

        console.log("adding input:", suitableUtxo.txid, suitableUtxo.vout, feePayerScript, suitableUtxo.value);
        psbt.addInput({
          hash: suitableUtxo.txid,
          index: suitableUtxo.vout,
          witnessUtxo: {
            script: feePayerScript,
            value: suitableUtxo.value
          }
        });

          // Add change output
          console.log("adding output:", address, changeAmount);
          psbt.addOutput({
            address: address, // Send change back to wallet address
            value: changeAmount
          });

        console.log("PSBT created successfully");
        console.log("Network:", btcNetwork === bitcoin.networks.bitcoin ? "mainnet" : "testnet");
        console.log("Anchor input - TXID:", transactionId, "VOUT:", anchorOutputIndex, "Value:", anchorOutputValue);
        console.log("Fee payer input - TXID:", suitableUtxo.txid, "VOUT:", suitableUtxo.vout, "Value:", suitableUtxo.value);
        console.log("Change output - Address:", address, "Value:", changeAmount);
        
        // set the psbt version to same as the parent transaction
        psbt.setVersion(transaction.version);
        console.log("PSBT version:", transaction.version);
        
        // Convert PSBT to hex for Unisat
        const psbtHex = psbt.toHex();
        console.log("PSBT hex:", psbtHex);

        // Sign with Unisat
        const unisat = (window as any).unisat;
        messageApi.info("Requesting signature from Unisat wallet...");
        
        const signedPsbtHex = await unisat.signPsbt(psbtHex);
        console.log("Signed PSBT:", signedPsbtHex);

        // Extract and broadcast the signed transaction
        const signedPsbt = bitcoin.Psbt.fromHex(signedPsbtHex);

        console.log("Signed PSBT:", signedPsbt);
        // signedPsbt.data.inputs[0].finalScriptWitness = Buffer.alloc(0);
        signedPsbt.data.inputs[0].finalScriptSig = Buffer.alloc(0);
        console.log("Signed PSBT:", signedPsbt);
        const finalTx = signedPsbt.extractTransaction();
        const finalTxHex = finalTx.toHex();
        
        console.log("Final transaction hex:", finalTxHex);
        console.log("Final transaction ID:", finalTx.getId());
        console.log("Final transaction weight:", finalTx.weight());

        messageApi.success(`Child transaction signed successfully! TXID: ${finalTx.getId()}`);

        // Update the child transaction structure with the actual signed transaction data
        setChildTxStructure({
          ...childTxStructure,
          signedTxHex: finalTxHex,
          signedTxId: finalTx.getId(),
          actualWeight: finalTx.weight()
        });

      } catch (psbtError) {
        console.error("Error creating/signing PSBT:", psbtError);
        messageApi.error(`Failed to create/sign child transaction: ${psbtError}`);
      }

      messageApi.success(`CPFP child transaction prepared! Fee: ${requiredFeeSats} sats, Change: ${changeAmount} sats`);
    } catch (error) {
      console.error("Error decoding transaction:", error);
      messageApi.error(`Failed to decode transaction: ${error}`);
      setDecodedTx(null);
      setTxid("");
      setTxWeight(0);
      setChildTxStructure(null);
    } finally {
      setCpfpLoading(false);
    }
  };

  // Function to create and sign RBF transaction
  const createRbfTransaction = async () => {
    if (!rbfRawTx.trim()) {
      messageApi.error("Please enter a raw transaction for RBF");
      return;
    }

    if (!address) {
      messageApi.error("No address available");
      return;
    }

    if (!rbfSelectedUtxo) {
      messageApi.error("Please select a UTXO to add as input");
      return;
    }

    setRbfLoading(true);
    try {
      // Parse the original transaction
      console.log("Parsing original transaction for RBF...");
      const originalTx = Transaction.fromHex(rbfRawTx.trim());
      const originalTxid = originalTx.getId();
      const originalWeight = originalTx.weight();
      
      setRbfDecodedTx(originalTx);
      setRbfTxid(originalTxid);
      setRbfTxWeight(originalWeight);

      console.log("Original transaction ID:", originalTxid);
      console.log("Original transaction weight:", originalWeight);
      console.log("Original inputs:", originalTx.ins.length);
      console.log("Original outputs:", originalTx.outs.length);

      // Calculate original transaction fee by fetching input values
      const apiEndpoint = getMempoolApiEndpoint();
      let totalInputValue = 0;
      const inputDetails: any[] = [];

      for (let i = 0; i < originalTx.ins.length; i++) {
        const input = originalTx.ins[i];
        const prevTxid = input.hash.reverse().toString("hex");
        input.hash.reverse(); // Reverse back to original
        const prevVout = input.index;

        try {
          const prevTxResponse = await fetch(`${apiEndpoint}tx/${prevTxid}`);
          if (prevTxResponse.ok) {
            const prevTxData = await prevTxResponse.json();
            const prevOutput = prevTxData.vout[prevVout];
            totalInputValue += prevOutput.value;
            inputDetails.push({
              txid: prevTxid,
              vout: prevVout,
              value: prevOutput.value,
              scriptPubKey: prevOutput.scriptpubkey
            });
          } else {
            throw new Error(`Failed to fetch previous tx: ${prevTxid}`);
          }
        } catch (fetchError) {
          console.error(`Error fetching input ${i}:`, fetchError);
          messageApi.error(`Failed to fetch input ${i} details`);
          return;
        }
      }

      const totalOutputValue = originalTx.outs.reduce((sum, out) => sum + out.value, 0);
      const originalFee = totalInputValue - totalOutputValue;
      const originalFeeRate = Math.ceil((originalFee / (originalWeight / 4)) * 100) / 100;

      console.log(`Original fee: ${originalFee} sats (${originalFeeRate} sat/vB)`);

      // Parse selected UTXO
      const [selectedTxid, selectedVoutStr] = rbfSelectedUtxo.split(":");
      const selectedVout = parseInt(selectedVoutStr);
      const selectedUtxoData = utxos.find(u => u.txid === selectedTxid && u.vout === selectedVout);

      if (!selectedUtxoData) {
        messageApi.error("Selected UTXO not found");
        return;
      }

      // Fetch scriptPubKey for the selected UTXO
      let selectedUtxoScript: string;
      try {
        const utxoTxResponse = await fetch(`${apiEndpoint}tx/${selectedTxid}`);
        if (!utxoTxResponse.ok) {
          throw new Error(`Failed to fetch UTXO transaction: ${utxoTxResponse.status}`);
        }
        const utxoTx = await utxoTxResponse.json();
        selectedUtxoScript = utxoTx.vout[selectedVout].scriptpubkey;
      } catch (apiError) {
        console.error("Error fetching UTXO script:", apiError);
        messageApi.error("Failed to fetch UTXO script");
        return;
      }

      console.log(`Selected UTXO: ${selectedTxid}:${selectedVout} with ${selectedUtxoData.value} sats`);

      // Estimate new weight (original + new input + new output)
      // New input weight estimate: ~68 WU for P2WPKH, ~272 WU for P2TR
      // New output weight estimate: ~34 WU for P2WPKH, ~43 WU for P2TR
      const newInputWeight = selectedUtxoScript.startsWith("5120") ? 272 : 68; // P2TR vs P2WPKH
      const newOutputWeight = address.startsWith("bc1p") || address.startsWith("tb1p") ? 43 : 34;
      const estimatedNewWeight = originalWeight + newInputWeight + newOutputWeight;
      const estimatedNewVBytes = Math.ceil(estimatedNewWeight / 4);

      // Calculate required fee for new transaction
      const requiredFee = Math.ceil(estimatedNewVBytes * rbfFeeRate);
      
      // The fee must be higher than original - RBF requires fee increase
      if (requiredFee <= originalFee) {
        messageApi.error(`New fee (${requiredFee} sats) must be higher than original fee (${originalFee} sats). Increase fee rate.`);
        return;
      }

      // Calculate additional fee needed
      const additionalFeeNeeded = requiredFee - originalFee;
      
      // Calculate change amount: selected UTXO value - additional fee needed
      const changeAmount = selectedUtxoData.value - additionalFeeNeeded;

      if (changeAmount < 546) { // Dust limit
        messageApi.error(`Insufficient funds. Change would be ${changeAmount} sats (below dust limit). Need UTXO with at least ${additionalFeeNeeded + 546} sats.`);
        return;
      }

      console.log(`Required fee: ${requiredFee} sats, additional needed: ${additionalFeeNeeded} sats`);
      console.log(`Change amount: ${changeAmount} sats`);

      // Create the RBF transaction structure
      const rbfStructure = {
        originalTxid,
        originalWeight,
        originalFee,
        originalFeeRate,
        originalInputs: inputDetails,
        originalOutputs: originalTx.outs.map((out, i) => ({
          index: i,
          value: out.value,
          script: out.script.toString("hex")
        })),
        newInput: {
          txid: selectedTxid,
          vout: selectedVout,
          value: selectedUtxoData.value,
          scriptPubKey: selectedUtxoScript
        },
        newOutput: {
          value: changeAmount,
          address: address
        },
        estimatedNewWeight,
        estimatedNewVBytes,
        requiredFee,
        newFeeRate: rbfFeeRate,
        additionalFeeNeeded
      };

      setRbfTxStructure(rbfStructure);

      // Determine network
      const btcNetwork = chainType === ChainType.BITCOIN_MAINNET ? 
        bitcoin.networks.bitcoin : bitcoin.networks.testnet;

      // Create PSBT for the new transaction
      const psbt = new bitcoin.Psbt({ network: btcNetwork });
      psbt.setVersion(originalTx.version);

      // Add all original inputs (with existing witness data preserved)
      for (let i = 0; i < originalTx.ins.length; i++) {
        const input = originalTx.ins[i];
        const prevTxid = input.hash.reverse().toString("hex");
        input.hash.reverse();
        
        psbt.addInput({
          hash: prevTxid,
          index: input.index,
          sequence: input.sequence,
          witnessUtxo: {
            script: Buffer.from(inputDetails[i].scriptPubKey, 'hex'),
            value: inputDetails[i].value
          }
        });

        // Mark existing inputs as finalized with their existing witness
        if (input.witness && input.witness.length > 0) {
          // Serialize witness data properly: varint count + for each element: varint length + data
          const witnessStack = input.witness;
          const serializedWitness = serializeWitness(witnessStack);
          psbt.data.inputs[i].finalScriptWitness = serializedWitness;
        }
      }

      // Add the new UTXO as the last input
      psbt.addInput({
        hash: selectedTxid,
        index: selectedVout,
        witnessUtxo: {
          script: Buffer.from(selectedUtxoScript, 'hex'),
          value: selectedUtxoData.value
        }
      });

      // Add all original outputs
      for (const output of originalTx.outs) {
        psbt.addOutput({
          script: output.script,
          value: output.value
        });
      }

      // Add change output as the last output
      psbt.addOutput({
        address: address,
        value: changeAmount
      });

      console.log("RBF PSBT created with:");
      console.log(`  Inputs: ${originalTx.ins.length + 1} (${originalTx.ins.length} original + 1 new)`);
      console.log(`  Outputs: ${originalTx.outs.length + 1} (${originalTx.outs.length} original + 1 change)`);

      // Request signature only for the new input
      const signInputIndex = originalTx.ins.length; // Last input (0-indexed)
      
      const psbtHex = psbt.toHex();
      console.log("RBF PSBT hex:", psbtHex);

      messageApi.info("Requesting signature for the new input from Unisat wallet...");

      try {
        // Sign only the new input
        const signedPsbtHex = await (window as any).unisat.signPsbt(psbtHex, {
          autoFinalized: true,
          toSignInputs: [{
            index: signInputIndex,
            address: address
          }]
        });

        console.log("Signed RBF PSBT:", signedPsbtHex);

        const signedPsbt = bitcoin.Psbt.fromHex(signedPsbtHex);
        
        // Finalize all inputs that weren't already finalized
        for (let i = 0; i < signedPsbt.data.inputs.length; i++) {
          if (!signedPsbt.data.inputs[i].finalScriptWitness && !signedPsbt.data.inputs[i].finalScriptSig) {
            try {
              signedPsbt.finalizeInput(i);
            } catch (finalizeError) {
              console.log(`Input ${i} already finalized or cannot be finalized:`, finalizeError);
            }
          }
        }

        const finalTx = signedPsbt.extractTransaction();
        const finalTxHex = finalTx.toHex();
        const finalTxId = finalTx.getId();
        const actualWeight = finalTx.weight();

        console.log("Final RBF transaction hex:", finalTxHex);
        console.log("Final RBF transaction ID:", finalTxId);
        console.log("Actual weight:", actualWeight);

        // Update structure with signed transaction info
        setRbfTxStructure({
          ...rbfStructure,
          signedTxHex: finalTxHex,
          signedTxId: finalTxId,
          actualWeight: actualWeight,
          actualFee: requiredFee,
          actualFeeRate: Math.ceil((requiredFee / (actualWeight / 4)) * 100) / 100
        });

        messageApi.success(`RBF transaction signed! New TXID: ${finalTxId}`);

      } catch (signError) {
        console.error("Error signing RBF transaction:", signError);
        messageApi.error(`Failed to sign RBF transaction: ${signError}`);
      }

    } catch (error) {
      console.error("Error creating RBF transaction:", error);
      messageApi.error(`Failed to create RBF transaction: ${error}`);
      setRbfDecodedTx(null);
      setRbfTxid("");
      setRbfTxWeight(0);
      setRbfTxStructure(null);
    } finally {
      setRbfLoading(false);
    }
  };

  const getBasicInfo = useCallback(async () => {
    const unisat = (window as any).unisat;

    try {
      const publicKey = await unisat.getPublicKey();
      setPublicKey(publicKey);
    } catch (e) {
      console.log("getPublicKey error", e);
    }

    try {
      const balanceV2 = await unisat.getBalanceV2();
      setBalanceV2(balanceV2);
      console.log("BalanceV2:", balanceV2);
    } catch (e) {
      console.log("getBalanceV2 error", e);
    }

    try {
      const chain = await unisat.getChain();
      setChainType(chain.enum);
    } catch (e) {
      console.log("getChain error", e);
    }

    try {
      const network = await unisat.getNetwork();
      setNetwork(network);
    } catch (e) {
      console.log("getNetwork error", e);
    }

    try {
      const version = await unisat.getVersion();
      setVersion(version);
    } catch (e) {
      console.log("getVersion error ", e);
    }

    if (unisat.getChain !== undefined) {
      try {
        const chain = await unisat.getChain();
        setChainType(chain.enum);
      } catch (e) {
        console.log("getChain error", e);
      }
    }
  }, []);

  const selfRef = useRef<{ accounts: string[] }>({
    accounts: [],
  });
  const self = selfRef.current;
  const handleAccountsChanged = useCallback((_accounts: string[]) => {
    console.log("accounts changed", _accounts);
    if (self.accounts[0] === _accounts[0]) {
      // prevent from triggering twice
      return;
    }
    self.accounts = _accounts;
    if (_accounts.length > 0) {
      setConnected(true);
      setAddress(_accounts[0]);
      getBasicInfo();
    } else {
      setConnected(false);
    }
  }, [self, getBasicInfo]);

  const handleNetworkChanged = useCallback((network: string) => {
    console.log("network changed", network);
    setNetwork(network);
    getBasicInfo();
  }, [getBasicInfo]);

  const handleChainChanged = useCallback((chain: {
    enum: ChainType;
    name: string;
    network: string;
  }) => {
    console.log("chain changed", chain);
    setChainType(chain.enum);
    getBasicInfo();
  }, [getBasicInfo]);

  useEffect(() => {
    async function checkUnisat() {
      let unisat = (window as any).unisat;

      for (let i = 1; i < 10 && !unisat; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * i));
        unisat = (window as any).unisat;
      }

      if (unisat) {
        setUnisatInstalled(true);
      } else if (!unisat) return;

      unisat
        .getAccounts()
        .then((accounts: string[]) => {
          // 主动获取一次账户信息
          handleAccountsChanged(accounts);
        })
        .catch((e: any) => {
          messageApi.error((e as any).message);
        });

      unisat.on("accountsChanged", handleAccountsChanged);
      unisat.on("networkChanged", handleNetworkChanged);
      unisat.on("chainChanged", handleChainChanged);

      return () => {
        unisat.removeListener("accountsChanged", handleAccountsChanged);
        unisat.removeListener("networkChanged", handleNetworkChanged);
        unisat.removeListener("chainChanged", handleChainChanged);
      };
    }

    checkUnisat().then();
  }, [handleAccountsChanged, handleChainChanged, handleNetworkChanged, messageApi]);

  // Auto-reload UTXOs every 5 seconds when connected and auto-reload is enabled
  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    if (connected && address && utxoAutoReload) {
      // Initial fetch
      fetchUtxos(false);
      
      // Set up auto-reload interval
      intervalId = setInterval(() => {
        fetchUtxos(false);
      }, 5000); // 5 seconds
      
      console.log("UTXO auto-reload enabled (5s interval)");
    }

    // Cleanup interval on unmount or when conditions change
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
        console.log("UTXO auto-reload disabled");
      }
    };
  }, [connected, address, utxoAutoReload, fetchUtxos]);

  if (!unisatInstalled) {
    return (
      <div className="App">
        <header className="App-header">
          {contextHolder}
          <div>
            <Button
              onClick={() => {
                window.location.href = "https://unisat.io";
              }}
            >
              Install Unisat Wallet
            </Button>
          </div>
        </header>
      </div>
    );
  }

  const unisat = (window as any).unisat;

  const items: CollapseProps["items"] = [
    {
      key: "sendBitcoin",
      label: <div style={{ textAlign: "start" }}>unisat.sendBitcoin</div>,
      children: <SendBitcoinCard />,
    },
    {
      key: "sendInscription",
      label: <div style={{ textAlign: "start" }}>unisat.sendInscription</div>,
      children: <SendInscriptionCard />,
    },
    {
      key: "sendRunes",
      label: <div style={{ textAlign: "start" }}>unisat.sendRunes</div>,
      children: <SendRunesCard />,
    },
    {
      key: "inscribeTransfer",
      label: <div style={{ textAlign: "start" }}>unisat.inscribeTransfer</div>,
      children: <InscribeTransferCard />,
    },
    {
      key: "signMessage",
      label: <div style={{ textAlign: "start" }}>unisat.signMessage</div>,
      children: <SignMessageCard />,
    },
    {
      key: "multiSignMessage",
      label: <div style={{ textAlign: "start" }}>unisat.multiSignMessage</div>,
      children: <MultiSignMessageCard />,
    },
    {
      key: "signPsbt",
      label: <div style={{ textAlign: "start" }}>unisat.signPsbt</div>,
      children: <SignPsbtCard />,
    },
    {
      key: "signPsbts",
      label: <div style={{ textAlign: "start" }}>unisat.signPsbts</div>,
      children: <SignPsbtsCard />,
    },
    {
      key: "pushPsbt",
      label: <div style={{ textAlign: "start" }}>unisat.pushPsbt</div>,
      children: <PushPsbtCard />,
    },
    {
      key: "pushTx",
      label: <div style={{ textAlign: "start" }}>unisat.pushTx</div>,
      children: <PushTxCard />,
    },
  ];

  const chains = Object.keys(CHAINS_MAP).map((key) => {
    const chain = CHAINS_MAP[key as ChainType];
    return {
      label: chain.label,
      value: chain.enum,
    };
  });

  const supportLegacyNetworks = ["livenet", "testnet"];
  return (
    <div className="App">
      <header className="App-header">
        <div className="header-container">
          <div style={{ minWidth: 100 }}> </div>
          <p>Unisat Wallet Demo</p>
          <div style={{ minWidth: 100 }}>
            {connected ? (
              <Button
                onClick={async () => {
                  await unisat.disconnect();
                }}
              >
                disconnect
              </Button>
            ) : null}
          </div>
        </div>

        {contextHolder}
        {connected ? (
          <div className="wallet-info-container">
            <div className="info-cards-container">
              <Card size="small" title="Wallet Info" style={{ flex: 1 }}>
                <div style={{ textAlign: "left", marginTop: 10 }}>
                  <div style={{ fontWeight: "bold" }}>Version:</div>
                  <div style={{ wordWrap: "break-word" }}>{version}</div>
                </div>

                {chain ? (
                  <div style={{ textAlign: "left", marginTop: 10 }}>
                    <div style={{ fontWeight: "bold" }}>Chain:</div>
                    <Radio.Group
                      onChange={async (e) => {
                        try {
                          const chain = await unisat.switchChain(
                            e.target.value
                          );
                          setChainType(chain.enum);
                        } catch (e) {
                          messageApi.error((e as any).message);
                        }
                      }}
                      value={chain.enum}
                    >
                      {chains.map((chain) => (
                        <Radio key={chain.value} value={chain.value}>
                          {chain.label}
                        </Radio>
                      ))}
                    </Radio.Group>
                  </div>
                ) : null}

                <div style={{ textAlign: "left", marginTop: 10 }}>
                  <div style={{ fontWeight: "bold" }}>Network:</div>
                  {supportLegacyNetworks.includes(network) ? (
                    <Radio.Group
                      onChange={async (e) => {
                        try {
                          const network = await unisat.switchNetwork(
                            e.target.value
                          );
                          setNetwork(network);
                        } catch (e) {
                          messageApi.error((e as any).message);
                        }
                      }}
                      value={network}
                    >
                      <Radio value={"livenet"}>livenet</Radio>
                      <Radio value={"testnet"}>testnet</Radio>
                    </Radio.Group>
                  ) : (
                    <div>
                      <p>
                        "unisat.getNetwork" is legacy. Please use
                        "unisat.getChain" instead.{" "}
                      </p>
                    </div>
                  )}
                </div>

                <div style={{ textAlign: "left", marginTop: 10 }}>
                  <div style={{ fontWeight: "bold" }}>Mempool API:</div>
                  <Input
                    value={mempoolApiUrl}
                    onChange={(e) => setMempoolApiUrl(e.target.value)}
                    placeholder="Enter mempool API URL"
                    style={{ marginTop: 5 }}
                  />
                  <div
                    style={{ fontSize: "12px", color: "#666", marginTop: 5 }}
                  >
                    Using API endpoint: {getMempoolApiEndpoint()}
                  </div>
                </div>
              </Card>
              <Card size="small" title="Account Info" style={{ flex: 1 }}>
                <div style={{ textAlign: "left", marginTop: 10 }}>
                  <div style={{ fontWeight: "bold" }}>Address:</div>
                  <div
                    style={{ wordWrap: "break-word" }}
                    onClick={() => {
                      copyToClipboard(address);
                      messageApi.success("Address Copied.");
                    }}
                  >
                    {address}
                  </div>
                </div>

                <div style={{ textAlign: "left", marginTop: 10 }}>
                  <div style={{ fontWeight: "bold" }}>PublicKey:</div>
                  <div
                    style={{ wordWrap: "break-word" }}
                    onClick={() => {
                      copyToClipboard(publicKey);
                      messageApi.success("PublicKey Copied.");
                    }}
                  >
                    {publicKey}
                  </div>
                </div>

                <div style={{ textAlign: "left", marginTop: 10 }}>
                  <div style={{ fontWeight: "bold" }}>Balance </div>
                  <div style={{ wordWrap: "break-word" }}>
                    <div>
                      Available: {satoshisToAmount(balanceV2.available)}{" "}
                      {chain && chain.unit}
                    </div>
                    <div>
                      Unavailable: {satoshisToAmount(balanceV2.unavailable)}{" "}
                      {chain && chain.unit}
                    </div>
                    <div>
                      Total: {satoshisToAmount(balanceV2.total)}{" "}
                      {chain && chain.unit}
                    </div>
                  </div>
                </div>
              </Card>
            </div>

            <Card
              size="small"
              title="UTXOs"
              style={{ width: "100%", marginBottom: 20 }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <div style={{ fontWeight: "bold" }}>
                  Address UTXOs ({utxos.length})
                  {utxoAutoReload && (
                    <span style={{ fontSize: "12px", color: "#52c41a", marginLeft: 8 }}>
                      (Auto-reload: 5s)
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Button
                    onClick={() => setUtxoAutoReload(!utxoAutoReload)}
                    size="small"
                    type={utxoAutoReload ? "primary" : "default"}
                  >
                    Auto {utxoAutoReload ? "ON" : "OFF"}
                  </Button>
                  <Button
                    onClick={() => fetchUtxos()}
                    loading={utxoLoading}
                    disabled={!address}
                    size="small"
                  >
                    Reload
                  </Button>
                </div>
              </div>

              {utxos.length === 0 && !utxoLoading ? (
                <div
                  style={{ textAlign: "center", color: "#666", padding: 20 }}
                >
                  No UTXOs loaded. Click "Reload" to fetch UTXOs.
                </div>
              ) : (
                <div style={{ maxHeight: "300px", overflowY: "auto" }}>
                  {utxos.map((utxo, index) => {
                    const mempoolBaseUrl = mempoolApiUrl.endsWith("/")
                      ? mempoolApiUrl.slice(0, -1)
                      : mempoolApiUrl;
                    const networkPath =
                      chainType === ChainType.BITCOIN_TESTNET4
                        ? "/testnet4"
                        : chainType === ChainType.BITCOIN_TESTNET
                        ? "/testnet"
                        : chainType === ChainType.BITCOIN_SIGNET
                        ? "/signet"
                        : "";
                    const txUrl = `${mempoolBaseUrl}${networkPath}/tx/${utxo.txid}#flow=&vout=${utxo.vout}`;

                    return (
                      <div
                        key={index}
                        style={{
                          border: "1px solid #d9d9d9",
                          borderRadius: 4,
                          padding: 10,
                          marginBottom: 8,
                          backgroundColor: "#fafafa",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <div>
                            <a
                              href={txUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontWeight: "bold", color: "#1890ff" }}
                            >
                              {utxo.txid}:{utxo.vout}
                            </a>
                          </div>
                          <div style={{ fontWeight: "bold" }}>
                            {satoshisToAmount(utxo.value)} {chain && chain.unit}
                          </div>
                        </div>
                        <div
                          style={{
                            marginTop: 5,
                            fontSize: "12px",
                            color: "#666",
                          }}
                        >
                          Status:{" "}
                          {utxo.status.confirmed ? (
                            <span style={{ color: "green" }}>
                              Confirmed (Block: {utxo.status.block_height})
                            </span>
                          ) : (
                            <span style={{ color: "orange" }}>Unconfirmed</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card
              size="small"
              title="Tx CPFP Bumper"
              style={{ width: "100%", marginBottom: 20 }}
            >
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontWeight: "bold", marginBottom: 8 }}>
                  Raw Transaction:
                </div>
                <Input.TextArea
                  value={rawTx}
                  onChange={(e) => setRawTx(e.target.value)}
                  placeholder="Enter raw transaction hex here..."
                  rows={6}
                  style={{ fontFamily: "monospace", fontSize: "12px" }}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  marginBottom: 16,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: "bold" }}>Fee Rate:</span>
                  <InputNumber
                    value={feeRate}
                    onChange={(value) => setFeeRate(value || 1)}
                    min={0.1}
                    max={1000}
                    step={0.1}
                    precision={1}
                    style={{ width: 150 }}
                    addonAfter="sat/vB"
                  />
                </div>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  type="primary"
                  onClick={createAndSignChildTx}
                  loading={cpfpLoading}
                  disabled={!rawTx.trim() || !address}
                  style={{ flex: 1 }}
                >
                  Create and Sign Child Tx
                </Button>
                <Button
                  onClick={() => {
                    setDecodedTx(null);
                    setTxid("");
                    setTxWeight(0);
                    setChildTxStructure(null);
                    console.log("Cleared decoded transaction state, txid, weight, and child tx");
                  }}
                  disabled={!decodedTx}
                  type="default"
                >
                  Clear
                </Button>
              </div>

              <div style={{ marginTop: 12, fontSize: "12px", color: "#666" }}>
                <strong>CPFP (Child Pays for Parent):</strong> Creates a child
                transaction that spends from the parent transaction with a
                higher fee rate to accelerate confirmation.
              </div>

              {decodedTx && (
                <div
                  style={{
                    marginTop: 16,
                    padding: 12,
                    backgroundColor: "#f5f5f5",
                    borderRadius: 4,
                  }}
                >
                  <div style={{ fontWeight: "bold", marginBottom: 8 }}>
                    Decoded Transaction:
                  </div>
                  <div
                    style={{
                      fontFamily: "monospace",
                      fontSize: "12px",
                      lineHeight: "1.5",
                    }}
                  >
                    <div>
                      <strong>Transaction ID:</strong> {txid}
                    </div>
                    <div>
                      <strong>Version:</strong> {decodedTx.version}
                    </div>
                    <div>
                      <strong>Weight:</strong> {txWeight} WU
                    </div>
                    {childTxStructure && childTxStructure.parentFee > 0 && (
                      <div>
                        <strong>Fee:</strong> {childTxStructure.parentFee} sats ({childTxStructure.parentFeeRate} sat/vB)
                      </div>
                    )}
                    <div>
                      <strong>Locktime:</strong> {decodedTx.locktime}
                    </div>
                    <div>
                      <strong>Inputs:</strong> {decodedTx.ins.length}
                    </div>
                    {decodedTx.ins.map((input, index) => (
                      <div key={index} style={{ marginLeft: 16, marginTop: 4 }}>
                        <div>
                          Input {index}: {input.hash.reverse().toString("hex")}:
                          {input.index}
                        </div>
                        <div style={{ marginLeft: 16 }}>
                          Sequence: {input.sequence}
                        </div>
                      </div>
                    ))}
                    <div style={{ marginTop: 8 }}>
                      <strong>Outputs:</strong> {decodedTx.outs.length}
                    </div>
                    {decodedTx.outs.map((output, index) => (
                      <div key={index} style={{ marginLeft: 16, marginTop: 4 }}>
                        <div>
                          Output {index}: {satoshisToAmount(output.value)}{" "}
                          {chain && chain.unit}
                        </div>
                        <div style={{ marginLeft: 16 }}>
                          Script: {output.script.toString("hex")}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {childTxStructure && (
                <div
                  style={{
                    marginTop: 16,
                    padding: 12,
                    backgroundColor: "#e6f4ff",
                    borderRadius: 4,
                    border: "1px solid #91caff",
                  }}
                >
                  <div style={{ fontWeight: "bold", marginBottom: 8 }}>
                    Child Transaction (CPFP):
                  </div>
                  <div
                    style={{
                      fontFamily: "monospace",
                      fontSize: "12px",
                      lineHeight: "1.5",
                    }}
                  >
                    <div>
                      <strong>Total Fee:</strong> {childTxStructure.totalFee} sats
                    </div>
                    <div>
                      <strong>Target Fee Rate:</strong> {childTxStructure.feeRate} sat/vB
                    </div>
                    <div>
                      <strong>Package Fee Rate:</strong> {childTxStructure.packageFeeRate} sat/vB
                    </div>
                    <div>
                      <strong>Parent Weight:</strong> {childTxStructure.parentWeight} WU
                    </div>
                    <div>
                      <strong>Parent Fee:</strong> {childTxStructure.parentFee} sats
                      {childTxStructure.parentFeeRate > 0 && (
                        <span style={{ marginLeft: 8 }}>
                          ({childTxStructure.parentFeeRate} sat/vB)
                        </span>
                      )}
                    </div>
                    <div>
                      <strong>Child Weight (est):</strong> {childTxStructure.estimatedChildWeight} WU
                      {childTxStructure.actualWeight && (
                        <span style={{ color: "#52c41a", marginLeft: 8 }}>
                          (Actual: {childTxStructure.actualWeight} WU)
                        </span>
                      )}
                    </div>
                    <div>
                      <strong>Total Package:</strong> {childTxStructure.totalWeight} WU ({childTxStructure.totalVirtualBytes} vB)
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <strong>Inputs ({childTxStructure.inputs.length}):</strong>
                    </div>
                    {childTxStructure.inputs.map((input: any, index: number) => (
                      <div key={index} style={{ marginLeft: 16, marginTop: 4 }}>
                        <div>
                          Input {index}: {input.txid}:{input.vout}
                        </div>
                        <div style={{ marginLeft: 16 }}>
                          Value: {satoshisToAmount(input.value)} {chain && chain.unit}
                        </div>
                        {index === 0 && (
                          <div style={{ marginLeft: 16, color: "#1890ff" }}>
                            (Anchor output from parent)
                          </div>
                        )}
                        {index === 1 && (
                          <div style={{ marginLeft: 16, color: "#52c41a" }}>
                            (Fee payer UTXO)
                          </div>
                        )}
                      </div>
                    ))}
                    <div style={{ marginTop: 8 }}>
                      <strong>Outputs ({childTxStructure.outputs.length}):</strong>
                    </div>
                    {childTxStructure.outputs.map((output: any, index: number) => (
                      <div key={index} style={{ marginLeft: 16, marginTop: 4 }}>
                        <div>
                          Output {index}: {satoshisToAmount(output.value)} {chain && chain.unit}
                        </div>
                        <div style={{ marginLeft: 16, color: "#722ed1" }}>
                          (Change back to wallet)
                        </div>
                      </div>
                    ))}
                    
                    {childTxStructure.signedTxId && (
                      <div style={{ marginTop: 12, padding: 8, backgroundColor: "#f6ffed", borderRadius: 4, border: "1px solid #b7eb8f" }}>
                        <div style={{ fontWeight: "bold", color: "#52c41a" }}>
                          ✅ Transaction Signed Successfully!
                        </div>
                        <div style={{ marginTop: 4 }}>
                          <strong>Signed TXID:</strong> 
                          <div style={{ wordBreak: "break-all", fontFamily: "monospace", fontSize: "11px" }}>
                            {childTxStructure.signedTxId}
                          </div>
                        </div>
                        {childTxStructure.signedTxHex && (
                          <div style={{ marginTop: 4 }}>
                            <strong>Raw Transaction:</strong>
                            <div style={{ 
                              wordBreak: "break-all", 
                              fontFamily: "monospace", 
                              fontSize: "10px", 
                              maxHeight: "60px", 
                              overflowY: "auto",
                              backgroundColor: "#ffffff",
                              padding: 4,
                              borderRadius: 2,
                              border: "1px solid #d9d9d9"
                            }}>
                              {childTxStructure.signedTxHex}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </Card>

            <Card
              size="small"
              title="Tx RBF Bumper"
              style={{ width: "100%", marginBottom: 20 }}
            >
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontWeight: "bold", marginBottom: 8 }}>
                  Raw Transaction to Replace:
                </div>
                <Input.TextArea
                  value={rbfRawTx}
                  onChange={(e) => setRbfRawTx(e.target.value)}
                  placeholder="Enter raw transaction hex here to bump with RBF..."
                  rows={6}
                  style={{ fontFamily: "monospace", fontSize: "12px" }}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  marginBottom: 16,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: "bold" }}>New Fee Rate:</span>
                  <InputNumber
                    value={rbfFeeRate}
                    onChange={(value) => setRbfFeeRate(value || 1)}
                    min={1}
                    max={1000}
                    step={1}
                    style={{ width: 150 }}
                    addonAfter="sat/vB"
                  />
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
                  <span style={{ fontWeight: "bold" }}>Select UTXO:</span>
                  <select
                    value={rbfSelectedUtxo}
                    onChange={(e) => setRbfSelectedUtxo(e.target.value)}
                    style={{ 
                      flex: 1, 
                      padding: "4px 8px", 
                      borderRadius: 4, 
                      border: "1px solid #d9d9d9",
                      fontFamily: "monospace",
                      fontSize: "12px"
                    }}
                  >
                    <option value="">-- Select a UTXO to add --</option>
                    {utxos.filter(u => u.status.confirmed).map((utxo, idx) => (
                      <option key={idx} value={`${utxo.txid}:${utxo.vout}`}>
                        {utxo.txid.slice(0, 8)}...:{utxo.vout} ({satoshisToAmount(utxo.value)} {chain && chain.unit})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  type="primary"
                  onClick={createRbfTransaction}
                  loading={rbfLoading}
                  disabled={!rbfRawTx.trim() || !address || !rbfSelectedUtxo}
                  style={{ flex: 1 }}
                >
                  Create RBF Transaction
                </Button>
                <Button
                  onClick={() => {
                    setRbfDecodedTx(null);
                    setRbfTxid("");
                    setRbfTxWeight(0);
                    setRbfTxStructure(null);
                    setRbfSelectedUtxo("");
                    console.log("Cleared RBF transaction state");
                  }}
                  disabled={!rbfDecodedTx && !rbfTxStructure}
                  type="default"
                >
                  Clear
                </Button>
              </div>

              <div style={{ marginTop: 12, fontSize: "12px", color: "#666" }}>
                <strong>RBF (Replace-By-Fee):</strong> Creates a replacement transaction 
                by adding a new UTXO as input and a change output. The existing signatures 
                remain unchanged. The new input covers the additional fee needed.
              </div>

              {rbfDecodedTx && (
                <div
                  style={{
                    marginTop: 16,
                    padding: 12,
                    backgroundColor: "#f5f5f5",
                    borderRadius: 4,
                  }}
                >
                  <div style={{ fontWeight: "bold", marginBottom: 8 }}>
                    Original Transaction:
                  </div>
                  <div
                    style={{
                      fontFamily: "monospace",
                      fontSize: "12px",
                      lineHeight: "1.5",
                    }}
                  >
                    <div>
                      <strong>Transaction ID:</strong> {rbfTxid}
                    </div>
                    <div>
                      <strong>Version:</strong> {rbfDecodedTx.version}
                    </div>
                    <div>
                      <strong>Weight:</strong> {rbfTxWeight} WU
                    </div>
                    {rbfTxStructure && (
                      <div>
                        <strong>Fee:</strong> {rbfTxStructure.originalFee} sats ({rbfTxStructure.originalFeeRate} sat/vB)
                      </div>
                    )}
                    <div>
                      <strong>Inputs:</strong> {rbfDecodedTx.ins.length}
                    </div>
                    <div>
                      <strong>Outputs:</strong> {rbfDecodedTx.outs.length}
                    </div>
                  </div>
                </div>
              )}

              {rbfTxStructure && (
                <div
                  style={{
                    marginTop: 16,
                    padding: 12,
                    backgroundColor: "#fff7e6",
                    borderRadius: 4,
                    border: "1px solid #ffd591",
                  }}
                >
                  <div style={{ fontWeight: "bold", marginBottom: 8 }}>
                    RBF Transaction Details:
                  </div>
                  <div
                    style={{
                      fontFamily: "monospace",
                      fontSize: "12px",
                      lineHeight: "1.5",
                    }}
                  >
                    <div style={{ marginBottom: 8 }}>
                      <strong>Fee Comparison:</strong>
                      <div style={{ marginLeft: 16 }}>
                        <div>Original: {rbfTxStructure.originalFee} sats ({rbfTxStructure.originalFeeRate} sat/vB)</div>
                        <div style={{ color: "#fa8c16" }}>
                          New: {rbfTxStructure.requiredFee} sats ({rbfTxStructure.newFeeRate} sat/vB)
                        </div>
                        <div style={{ color: "#52c41a" }}>
                          Increase: +{rbfTxStructure.additionalFeeNeeded} sats
                        </div>
                      </div>
                    </div>

                    <div style={{ marginBottom: 8 }}>
                      <strong>Weight:</strong>
                      <div style={{ marginLeft: 16 }}>
                        <div>Original: {rbfTxStructure.originalWeight} WU</div>
                        <div>Estimated New: {rbfTxStructure.estimatedNewWeight} WU ({rbfTxStructure.estimatedNewVBytes} vB)</div>
                        {rbfTxStructure.actualWeight && (
                          <div style={{ color: "#52c41a" }}>
                            Actual: {rbfTxStructure.actualWeight} WU
                          </div>
                        )}
                      </div>
                    </div>

                    <div style={{ marginBottom: 8 }}>
                      <strong>New Input (added as last):</strong>
                      <div style={{ marginLeft: 16, color: "#fa8c16" }}>
                        {rbfTxStructure.newInput.txid}:{rbfTxStructure.newInput.vout}
                        <div>Value: {satoshisToAmount(rbfTxStructure.newInput.value)} {chain && chain.unit}</div>
                      </div>
                    </div>

                    <div style={{ marginBottom: 8 }}>
                      <strong>New Output (added as last):</strong>
                      <div style={{ marginLeft: 16, color: "#722ed1" }}>
                        Change: {satoshisToAmount(rbfTxStructure.newOutput.value)} {chain && chain.unit}
                        <div style={{ fontSize: "10px", wordBreak: "break-all" }}>
                          To: {rbfTxStructure.newOutput.address}
                        </div>
                      </div>
                    </div>

                    {rbfTxStructure.signedTxId && (
                      <div style={{ marginTop: 12, padding: 8, backgroundColor: "#f6ffed", borderRadius: 4, border: "1px solid #b7eb8f" }}>
                        <div style={{ fontWeight: "bold", color: "#52c41a" }}>
                          ✅ RBF Transaction Signed Successfully!
                        </div>
                        <div style={{ marginTop: 4 }}>
                          <strong>New TXID:</strong> 
                          <div style={{ wordBreak: "break-all", fontFamily: "monospace", fontSize: "11px" }}>
                            {rbfTxStructure.signedTxId}
                          </div>
                        </div>
                        {rbfTxStructure.actualFeeRate && (
                          <div style={{ marginTop: 4 }}>
                            <strong>Actual Fee Rate:</strong> {rbfTxStructure.actualFeeRate} sat/vB
                          </div>
                        )}
                        {rbfTxStructure.signedTxHex && (
                          <div style={{ marginTop: 4 }}>
                            <strong>Raw Transaction:</strong>
                            <div style={{ 
                              wordBreak: "break-all", 
                              fontFamily: "monospace", 
                              fontSize: "10px", 
                              maxHeight: "60px", 
                              overflowY: "auto",
                              backgroundColor: "#ffffff",
                              padding: 4,
                              borderRadius: 2,
                              border: "1px solid #d9d9d9"
                            }}>
                              {rbfTxStructure.signedTxHex}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </Card>

            <Collapse
              className="collapse-container"
              items={items}
              defaultActiveKey={[]}
              onChange={() => {
                // todo
              }}
            />
          </div>
        ) : (
          <div>
            <Button
              onClick={async () => {
                try {
                  const result = await unisat.requestAccounts();
                  handleAccountsChanged(result);
                } catch (e) {
                  messageApi.error((e as any).message);
                }
              }}
            >
              Connect Unisat Wallet
            </Button>
          </div>
        )}
      </header>
    </div>
  );
}

export default App;
